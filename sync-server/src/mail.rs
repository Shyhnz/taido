//! E-mail sending for the forgotten-password codes: a [`Mailer`]
//! trait, the SMTP implementation ([`SmtpMailer`], lettre over implicit TLS) and an in-memory
//! one for tests ([`MemoryMailer`]). Every mail has a plain-text part and an HTML part
//! ([`crate::mail_template`]). Addresses, codes and the SMTP password are never logged.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::SUBMISSIONS_PORT;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use tokio::sync::Notify;

use crate::error::ServerError;
use crate::mail_template as tpl;

/// One e-mail: subject, plain-text body and HTML body (which shows the inline logo).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mail {
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// Subject of the code e-mail.
pub const CODE_SUBJECT: &str = "Ton code Taido";

/// Plain-text body of the code e-mail.
pub fn code_text(code: &str) -> String {
    format!(
        "Ton code pour changer de mot de passe : {code}. Il est valable 30 minutes. \
         Si tu n'as rien demandé, ignore ce message."
    )
}

/// The forgotten-password mail carrying `code` (six digits).
pub fn code_mail(code: &str, public_url: Option<&str>) -> Mail {
    let body = [
        tpl::paragraph("Tape ce code dans Taido, là où tu as demandé à changer de mot de passe."),
        tpl::code_boxes(code, "Valable 30 minutes"),
        tpl::quiet("Tu n'as rien demandé ? Ignore ce message, ton mot de passe ne change pas."),
    ]
    .concat();
    Mail {
        subject: CODE_SUBJECT.to_string(),
        text: code_text(code),
        html: tpl::layout(
            "Valable 30 minutes.",
            "Ton code pour changer de mot de passe",
            &body,
            "Tu reçois ce mail parce qu'un nouveau mot de passe a été demandé pour ton compte.",
            public_url,
        ),
    }
}

/// Subject of the address-confirmation e-mail.
pub const VERIFY_SUBJECT: &str = "Confirme ton adresse";

/// How long a confirmation link stays valid.
pub const VERIFY_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

/// Path of the confirmation page (served by [`crate::http`]).
pub const CONFIRM_PATH: &str = "/confirmer";

/// The confirmation link for `token` on the server at `public_url` (no trailing slash).
pub fn confirm_link(public_url: &str, token: &str) -> String {
    format!("{public_url}{CONFIRM_PATH}?t={token}")
}

/// The address-confirmation mail sent at signup (and again on demand).
pub fn verify_mail(email: &str, link: &str, public_url: Option<&str>) -> Mail {
    let body = [
        tpl::paragraph(&format!(
            "Pour finir ton inscription, confirme que {email} est bien ton adresse."
        )),
        tpl::button(link, "Confirmer mon adresse"),
        tpl::link_fallback(
            "Le bouton ne marche pas ? Copie ce lien dans ton navigateur :",
            link,
        ),
        tpl::quiet(
            "Ce lien est valable 24 heures. Tu n'as pas créé de compte Taido ? Ignore ce message.",
        ),
    ]
    .concat();
    Mail {
        subject: VERIFY_SUBJECT.to_string(),
        text: format!(
            "Pour finir ton inscription, confirme que {email} est bien ton adresse : {link}\n\n\
             Ce lien est valable 24 heures. Tu n'as pas créé de compte Taido ? Ignore ce message."
        ),
        html: tpl::layout(
            "Dernière étape de ton inscription.",
            "Confirme ton adresse",
            &body,
            "Tu reçois ce mail parce qu'un compte Taido a été créé avec cette adresse.",
            public_url,
        ),
    }
}

/// Subject of the welcome e-mail.
pub const WELCOME_SUBJECT: &str = "Bienvenue dans Taido";

/// The welcome mail, sent once the address is confirmed: how to add the phone.
pub fn welcome_mail(email: &str, public_url: &str) -> Mail {
    let host = public_url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let steps = [
        format!("Sur ton téléphone, ouvre {host}."),
        format!("Connecte-toi avec {email}."),
        "Ajoute l'appli à l'écran d'accueil.".to_string(),
    ];
    let lead = "Tes projets et tes tâches sont maintenant gardés sur ton compte. \
                Ajoute ton téléphone pour les retrouver partout.";
    let quiet = "Taido marche aussi dans le navigateur de n'importe quel ordinateur, \
                 à la même adresse.";
    let body = [
        tpl::paragraph(lead),
        tpl::steps(&steps),
        tpl::button(public_url, "Ouvrir Taido sur le téléphone"),
        tpl::quiet(quiet),
    ]
    .concat();
    Mail {
        subject: WELCOME_SUBJECT.to_string(),
        text: format!(
            "Ton compte est prêt. {lead}\n\n1. {}\n2. {}\n3. {}\n\n{quiet}",
            steps[0], steps[1], steps[2]
        ),
        html: tpl::layout(
            "Ton compte est prêt.",
            "Ton compte est prêt",
            &body,
            "Tu reçois ce mail parce qu'un compte Taido a été créé avec cette adresse.",
            Some(public_url),
        ),
    }
}

/// A date in French, e.g. "12 octobre 2026".
pub fn french_date(date: chrono::NaiveDate) -> String {
    use chrono::Datelike;
    const MONTHS: [&str; 12] = [
        "janvier",
        "février",
        "mars",
        "avril",
        "mai",
        "juin",
        "juillet",
        "août",
        "septembre",
        "octobre",
        "novembre",
        "décembre",
    ];
    let month = MONTHS.get(date.month0() as usize).copied().unwrap_or("");
    let day = if date.day() == 1 {
        "1er".to_string()
    } else {
        date.day().to_string()
    };
    format!("{day} {month} {}", date.year())
}

/// The token of the confirmation link in `text` (the text of a [`verify_mail`]).
pub fn confirm_token_in(text: &str) -> Option<String> {
    let start = text.find("?t=")? + 3;
    let token: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    (!token.is_empty()).then_some(token)
}

/// The first run of exactly six digits in `text` (the code of a [`code_text`] mail).
pub fn code_in(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut start = 0;
    while start < bytes.len() {
        if bytes[start].is_ascii_digit() {
            let end = bytes[start..]
                .iter()
                .position(|b| !b.is_ascii_digit())
                .map_or(bytes.len(), |n| start + n);
            if end - start == 6 {
                return Some(text[start..end].to_string());
            }
            start = end;
        } else {
            start += 1;
        }
    }
    None
}

/// What [`Mailer::send`] returns: a future that does not block the runtime.
pub type SendFuture<'a> = Pin<Box<dyn Future<Output = Result<(), ServerError>> + Send + 'a>>;

/// Sends an e-mail. Asynchronous (SMTP takes hundreds of milliseconds); errors never
/// carry the address nor the content.
pub trait Mailer: Send + Sync {
    fn send<'a>(&'a self, to: &'a str, mail: &'a Mail) -> SendFuture<'a>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// SMTP settings from the environment. `Debug` hides the password.
#[derive(Clone, PartialEq, Eq)]
pub struct MailConfig {
    /// `TAIDO_SMTP_HOST`, e.g. `smtp.resend.com`.
    pub host: String,
    /// `TAIDO_SMTP_PORT`, default 465 (implicit TLS); another port uses STARTTLS.
    pub port: u16,
    /// `TAIDO_SMTP_USER` and `TAIDO_SMTP_PASSWORD` (both or neither).
    pub credentials: Option<(String, String)>,
    /// `TAIDO_MAIL_FROM`, e.g. `Taido <compte@sync.example.com>`.
    pub from: String,
    /// `TAIDO_PUBLIC_URL`, e.g. `https://sync.example.com` (no trailing slash): the
    /// address of this server in the links of the mails. `None`: no confirmation mail.
    pub public_url: Option<String>,
}

impl fmt::Debug for MailConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MailConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field(
                "user",
                &self.credentials.as_ref().map(|(user, _)| user.as_str()),
            )
            .field("password", &self.credentials.as_ref().map(|_| "<hidden>"))
            .field("from", &self.from)
            .field("public_url", &self.public_url)
            .finish()
    }
}

impl MailConfig {
    /// Reads the `TAIDO_SMTP_*` and `TAIDO_MAIL_FROM` variables. `Ok(None)` when
    /// `TAIDO_SMTP_HOST` is unset or empty (no e-mail: `/api/password/forgot` answers 503).
    pub fn from_env() -> Result<Option<MailConfig>, ServerError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<Option<MailConfig>, ServerError> {
        let non_empty = |key: &str| {
            lookup(key)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let Some(host) = non_empty("TAIDO_SMTP_HOST") else {
            return Ok(None);
        };
        let port = match non_empty("TAIDO_SMTP_PORT") {
            None => SUBMISSIONS_PORT,
            Some(port) => port
                .parse::<u16>()
                .ok()
                .filter(|p| *p != 0)
                .ok_or_else(|| ServerError::Invalid("TAIDO_SMTP_PORT is not a port".into()))?,
        };
        let credentials = match (
            non_empty("TAIDO_SMTP_USER"),
            non_empty("TAIDO_SMTP_PASSWORD"),
        ) {
            (Some(user), Some(password)) => Some((user, password)),
            (None, None) => None,
            _ => {
                return Err(ServerError::Invalid(
                    "set both TAIDO_SMTP_USER and TAIDO_SMTP_PASSWORD, or neither".into(),
                ))
            }
        };
        let from = non_empty("TAIDO_MAIL_FROM").ok_or_else(|| {
            ServerError::Invalid("TAIDO_MAIL_FROM is required with TAIDO_SMTP_HOST".into())
        })?;
        let public_url = match non_empty("TAIDO_PUBLIC_URL") {
            None => None,
            Some(url) => {
                let url = url.trim_end_matches('/').to_string();
                if !(url.starts_with("https://") || url.starts_with("http://")) {
                    return Err(ServerError::Invalid(
                        "TAIDO_PUBLIC_URL must start with https://".into(),
                    ));
                }
                Some(url)
            }
        };
        Ok(Some(MailConfig {
            host,
            port,
            credentials,
            from,
            public_url,
        }))
    }
}

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

/// Longest wait for the SMTP server, per connection step.
pub const SMTP_TIMEOUT: Duration = Duration::from_secs(20);

/// Sends through an SMTP relay (Resend: `smtp.resend.com`, port 465, user `resend`, password
/// = API key). Port 465 uses implicit TLS, any other port STARTTLS (TLS required); the
/// certificate is checked against the Mozilla roots (webpki-roots).
pub struct SmtpMailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl SmtpMailer {
    pub fn new(config: &MailConfig) -> Result<SmtpMailer, ServerError> {
        let builder = if config.port == SUBMISSIONS_PORT {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
        }
        .map_err(|_| ServerError::Invalid("TAIDO_SMTP_HOST is not a valid TLS host name".into()))?
        .port(config.port)
        .timeout(Some(SMTP_TIMEOUT));
        let builder = match &config.credentials {
            Some((user, password)) => {
                builder.credentials(Credentials::new(user.clone(), password.clone()))
            }
            None => builder,
        };
        let from: Mailbox = config.from.parse().map_err(|_| {
            ServerError::Invalid("TAIDO_MAIL_FROM is not an address like « Taido <a@b.c> »".into())
        })?;
        Ok(SmtpMailer {
            transport: builder.build(),
            from,
        })
    }
}

/// A description of an SMTP failure without the server's text (which may quote the address).
fn describe(err: &lettre::transport::smtp::Error) -> String {
    let kind = if err.is_timeout() {
        "timeout"
    } else if err.is_tls() {
        "tls"
    } else if err.is_permanent() {
        "permanent"
    } else if err.is_transient() {
        "transient"
    } else if err.is_response() {
        "response"
    } else if err.is_client() {
        "client"
    } else {
        "connection"
    };
    match err.status() {
        Some(code) => format!("smtp {kind} error, code {code}"),
        None => format!("smtp {kind} error"),
    }
}

impl Mailer for SmtpMailer {
    fn send<'a>(&'a self, to: &'a str, mail: &'a Mail) -> SendFuture<'a> {
        Box::pin(async move {
            let to: Mailbox = to
                .parse()
                .map_err(|_| ServerError::Mail("recipient address refused".into()))?;
            let png = ContentType::parse("image/png")
                .map_err(|_| ServerError::Mail("logo content type refused".into()))?;
            let body = MultiPart::alternative()
                .singlepart(SinglePart::plain(mail.text.clone()))
                .multipart(
                    MultiPart::related()
                        .singlepart(SinglePart::html(mail.html.clone()))
                        .singlepart(
                            Attachment::new_inline(tpl::LOGO_CID.to_string())
                                .body(tpl::LOGO_PNG.to_vec(), png),
                        ),
                );
            let message = Message::builder()
                .from(self.from.clone())
                .to(to)
                .subject(mail.subject.clone())
                .multipart(body)
                .map_err(|_| ServerError::Mail("message could not be built".into()))?;
            self.transport
                .send(message)
                .await
                .map(|_| ())
                .map_err(|err| ServerError::Mail(describe(&err)))
        })
    }
}

// ---------------------------------------------------------------------------
// In memory (tests)
// ---------------------------------------------------------------------------

/// Keeps the mails instead of sending them: `(to, subject, text)` (the HTML part is checked
/// on [`code_mail`] directly). Used by `TestServer` and
/// the tests; never sends anything.
#[derive(Default)]
pub struct MemoryMailer {
    pub sent: Mutex<Vec<(String, String, String)>>,
    failing: AtomicBool,
    notify: Notify,
}

impl MemoryMailer {
    pub fn new() -> MemoryMailer {
        MemoryMailer::default()
    }

    fn lock(&self) -> MutexGuard<'_, Vec<(String, String, String)>> {
        self.sent.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `true`: every send fails (and nothing is kept), like an SMTP outage.
    pub fn set_failing(&self, failing: bool) {
        self.failing.store(failing, Ordering::SeqCst);
    }

    /// `(subject, text)` of the mails sent to `to`, oldest first.
    pub fn mails_to(&self, to: &str) -> Vec<(String, String)> {
        self.lock()
            .iter()
            .filter(|(addr, _, _)| addr == to)
            .map(|(_, subject, text)| (subject.clone(), text.clone()))
            .collect()
    }

    /// Waits until `count` mails were sent to `to` (sending happens after the HTTP answer),
    /// at most `timeout`; returns them (fewer on timeout).
    pub async fn wait_for_mails_to(
        &self,
        to: &str,
        count: usize,
        timeout: Duration,
    ) -> Vec<(String, String)> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.notify.notified();
            let mails = self.mails_to(to);
            if mails.len() >= count {
                return mails;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.mails_to(to);
            }
        }
    }
}

impl Mailer for MemoryMailer {
    fn send<'a>(&'a self, to: &'a str, mail: &'a Mail) -> SendFuture<'a> {
        Box::pin(async move {
            if self.failing.load(Ordering::SeqCst) {
                return Err(ServerError::Mail("memory mailer set to fail".into()));
            }
            self.lock()
                .push((to.to_string(), mail.subject.clone(), mail.text.clone()));
            self.notify.notify_waiters();
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let vars: Vec<(String, String)> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key| vars.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    }

    #[test]
    fn no_host_means_no_mail() {
        assert_eq!(MailConfig::from_lookup(lookup(&[])).expect("config"), None);
        assert_eq!(
            MailConfig::from_lookup(lookup(&[("TAIDO_SMTP_HOST", "  ")])).expect("config"),
            None
        );
    }

    #[test]
    fn resend_configuration() {
        let config = MailConfig::from_lookup(lookup(&[
            ("TAIDO_SMTP_HOST", "smtp.resend.com"),
            ("TAIDO_SMTP_USER", "resend"),
            ("TAIDO_SMTP_PASSWORD", "re_secret_key"),
            ("TAIDO_MAIL_FROM", "Taido <compte@sync.example.com>"),
        ]))
        .expect("config")
        .expect("some");
        assert_eq!(config.host, "smtp.resend.com");
        assert_eq!(config.port, 465);
        assert_eq!(
            config.credentials,
            Some(("resend".to_string(), "re_secret_key".to_string()))
        );
        let debug = format!("{config:?}");
        assert!(!debug.contains("re_secret_key"), "{debug}");
        assert!(debug.contains("resend"));
    }

    #[test]
    fn configuration_errors() {
        let base = [
            ("TAIDO_SMTP_HOST", "smtp.resend.com"),
            ("TAIDO_MAIL_FROM", "Taido <compte@sync.example.com>"),
        ];
        let with = |extra: &[(&'static str, &'static str)]| {
            let mut vars = base.to_vec();
            vars.extend_from_slice(extra);
            MailConfig::from_lookup(lookup(&vars))
        };
        assert!(with(&[]).expect("no credentials is fine").is_some());
        assert_eq!(
            with(&[("TAIDO_SMTP_PORT", "587")])
                .expect("config")
                .expect("some")
                .port,
            587
        );
        assert!(with(&[("TAIDO_SMTP_PORT", "smtp")]).is_err());
        assert!(with(&[("TAIDO_SMTP_PORT", "0")]).is_err());
        assert!(with(&[("TAIDO_SMTP_USER", "resend")]).is_err());
        assert!(with(&[("TAIDO_SMTP_PASSWORD", "key")]).is_err());
        assert!(
            MailConfig::from_lookup(lookup(&[("TAIDO_SMTP_HOST", "smtp.resend.com")])).is_err()
        );
    }

    #[tokio::test]
    async fn smtp_mailer_checks_the_sender_address() {
        let mut config = MailConfig {
            host: "smtp.resend.com".into(),
            port: 465,
            credentials: Some(("resend".into(), "key".into())),
            from: "Taido <compte@sync.example.com>".into(),
            public_url: None,
        };
        assert!(SmtpMailer::new(&config).is_ok());
        config.port = 587;
        assert!(SmtpMailer::new(&config).is_ok());
        config.from = "not an address".into();
        assert!(SmtpMailer::new(&config).is_err());
    }

    #[test]
    fn public_url_is_read() {
        let base = [
            ("TAIDO_SMTP_HOST", "smtp.resend.com"),
            ("TAIDO_MAIL_FROM", "Taido <compte@sync.example.com>"),
        ];
        let with = |url: &'static str| {
            let mut vars = base.to_vec();
            vars.push(("TAIDO_PUBLIC_URL", url));
            MailConfig::from_lookup(lookup(&vars))
        };
        assert_eq!(
            with("https://sync.example.com/")
                .expect("config")
                .expect("some")
                .public_url
                .as_deref(),
            Some("https://sync.example.com")
        );
        assert!(with("sync.example.com").is_err());
        let none = MailConfig::from_lookup(lookup(&base))
            .expect("config")
            .expect("some");
        assert_eq!(none.public_url, None);
    }

    #[test]
    fn verify_mail_carries_the_link() {
        let link = confirm_link("https://taido.test", "abc_DEF-123");
        let mail = verify_mail("camille@exemple.fr", &link, None);
        assert_eq!(mail.subject, VERIFY_SUBJECT);
        assert_eq!(confirm_token_in(&mail.text).as_deref(), Some("abc_DEF-123"));
        assert!(mail
            .html
            .contains("href=\"https://taido.test/confirmer?t=abc_DEF-123\""));
        assert!(mail.html.contains("camille@exemple.fr"));
    }

    #[test]
    fn welcome_mail_explains_the_phone() {
        let mail = welcome_mail("camille@exemple.fr", "https://taido.test");
        assert_eq!(mail.subject, WELCOME_SUBJECT);
        assert!(mail.text.contains("ouvre taido.test") && mail.text.contains("camille@exemple.fr"));
        assert!(mail.html.contains("href=\"https://taido.test\""));
        assert!(mail.html.contains("Ton compte est prêt") && mail.html.contains(">3</td>"));
    }

    #[test]
    fn dates_are_written_in_french() {
        let date = |y, m, d| chrono::NaiveDate::from_ymd_opt(y, m, d).expect("date");
        assert_eq!(french_date(date(2026, 10, 12)), "12 octobre 2026");
        assert_eq!(french_date(date(2027, 2, 1)), "1er février 2027");
        assert_eq!(french_date(date(2026, 12, 31)), "31 décembre 2026");
    }

    #[test]
    fn mails_show_the_host_of_the_public_url_in_the_footer() {
        let url = Some("https://sync.example.com");
        for mail in [
            code_mail("042917", url),
            verify_mail(
                "c@exemple.fr",
                "https://sync.example.com/confirmer?t=a",
                url,
            ),
            welcome_mail("c@exemple.fr", "https://sync.example.com"),
        ] {
            assert!(mail.html.contains("<br>Taido · sync.example.com</td>"));
        }
        assert!(!code_mail("042917", None).html.contains("Taido ·"));
    }

    #[test]
    fn code_mail_has_both_parts() {
        let mail = code_mail("042917", None);
        assert_eq!(mail.subject, CODE_SUBJECT);
        assert_eq!(code_in(&mail.text).as_deref(), Some("042917"));
        assert!(mail.html.contains(">0</td>") && mail.html.contains(">7</td>"));
        assert!(mail.html.contains("Ton code pour changer de mot de passe"));
    }

    #[test]
    fn code_is_found_in_the_mail() {
        assert_eq!(code_in(&code_text("042917")).as_deref(), Some("042917"));
        assert_eq!(code_in("valable 30 minutes"), None);
        assert_eq!(code_in("1234567 then 123456").as_deref(), Some("123456"));
    }

    #[tokio::test]
    async fn memory_mailer_keeps_or_fails() {
        let mailer = MemoryMailer::new();
        let mail = Mail {
            subject: "s".into(),
            text: "t".into(),
            html: "h".into(),
        };
        mailer.send("a@b.co", &mail).await.expect("sent");
        assert_eq!(mailer.mails_to("a@b.co"), vec![("s".into(), "t".into())]);
        mailer.set_failing(true);
        assert!(mailer.send("a@b.co", &mail).await.is_err());
        assert_eq!(
            mailer
                .wait_for_mails_to("a@b.co", 2, Duration::from_millis(20))
                .await
                .len(),
            1
        );
    }
}
