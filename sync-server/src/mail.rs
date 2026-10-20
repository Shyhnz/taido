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

/// Environment variable that picks the language of the mails and pages.
pub const ENV_MAIL_LANG: &str = "TAIDO_MAIL_LANG";

/// Language of the e-mails and of the confirmation pages (`TAIDO_MAIL_LANG`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MailLang {
    /// English (the default).
    #[default]
    En,
    /// French.
    Fr,
}

impl MailLang {
    /// Reads [`ENV_MAIL_LANG`].
    pub fn from_env() -> Result<MailLang, ServerError> {
        Self::from_os_value(std::env::var_os(ENV_MAIL_LANG))
    }

    /// Like [`MailLang::from_env_value`], for a raw environment value: one that is not valid
    /// UTF-8 is refused (never read as English).
    pub fn from_os_value(value: Option<std::ffi::OsString>) -> Result<MailLang, ServerError> {
        match value {
            None => Self::from_env_value(None),
            Some(value) => match value.to_str() {
                Some(text) => Self::from_env_value(Some(text)),
                None => Err(Self::invalid()),
            },
        }
    }

    /// Unset or blank = English; else `en` or `fr`, in any case. Anything else is refused.
    pub fn from_env_value(value: Option<&str>) -> Result<MailLang, ServerError> {
        let value = value.map(str::trim).unwrap_or_default();
        if value.is_empty() || value.eq_ignore_ascii_case("en") {
            Ok(MailLang::En)
        } else if value.eq_ignore_ascii_case("fr") {
            Ok(MailLang::Fr)
        } else {
            Err(Self::invalid())
        }
    }

    fn invalid() -> ServerError {
        ServerError::Invalid(format!("{ENV_MAIL_LANG} must be \"en\" or \"fr\""))
    }

    /// The `lang` attribute of the HTML pages.
    pub fn code(self) -> &'static str {
        match self {
            MailLang::En => "en",
            MailLang::Fr => "fr",
        }
    }

    /// `en` or `fr` text, by language.
    pub fn pick(self, en: &'static str, fr: &'static str) -> &'static str {
        match self {
            MailLang::En => en,
            MailLang::Fr => fr,
        }
    }
}

/// Subject of the code e-mail.
pub fn code_subject(lang: MailLang) -> &'static str {
    lang.pick("Your Taido code", "Ton code Taido")
}

/// Plain-text body of the code e-mail.
pub fn code_text(code: &str, lang: MailLang) -> String {
    match lang {
        MailLang::En => format!(
            "Your code to change your password: {code}. It is valid for 30 minutes. \
             If you did not ask for it, ignore this message."
        ),
        MailLang::Fr => format!(
            "Ton code pour changer de mot de passe : {code}. Il est valable 30 minutes. \
             Si tu n'as rien demandé, ignore ce message."
        ),
    }
}

/// The forgotten-password mail carrying `code` (six digits).
pub fn code_mail(code: &str, public_url: Option<&str>, lang: MailLang) -> Mail {
    let body = [
        tpl::paragraph(lang.pick(
            "Enter this code in Taido, where you asked to change your password.",
            "Tape ce code dans Taido, là où tu as demandé à changer de mot de passe.",
        )),
        tpl::code_boxes(
            code,
            lang.pick("Valid for 30 minutes", "Valable 30 minutes"),
        ),
        tpl::quiet(lang.pick(
            "Didn't ask for this? Ignore this message; your password won't change.",
            "Tu n'as rien demandé ? Ignore ce message, ton mot de passe ne change pas.",
        )),
    ]
    .concat();
    Mail {
        subject: code_subject(lang).to_string(),
        text: code_text(code, lang),
        html: tpl::layout(
            lang.code(),
            lang.pick("Valid for 30 minutes.", "Valable 30 minutes."),
            lang.pick(
                "Your code to change your password",
                "Ton code pour changer de mot de passe",
            ),
            &body,
            lang.pick(
                "You are receiving this email because a new password was requested for your account.",
                "Tu reçois ce mail parce qu'un nouveau mot de passe a été demandé pour ton compte.",
            ),
            public_url,
        ),
    }
}

/// Subject of the address-confirmation e-mail.
pub fn verify_subject(lang: MailLang) -> &'static str {
    lang.pick("Confirm your address", "Confirme ton adresse")
}

/// How long a confirmation link stays valid.
pub const VERIFY_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

/// Path of the confirmation page (served by [`crate::http`]).
pub const CONFIRM_PATH: &str = "/confirmer";

/// The confirmation link for `token` on the server at `public_url` (no trailing slash).
pub fn confirm_link(public_url: &str, token: &str) -> String {
    format!("{public_url}{CONFIRM_PATH}?t={token}")
}

/// The address-confirmation mail sent at signup (and again on demand).
pub fn verify_mail(email: &str, link: &str, public_url: Option<&str>, lang: MailLang) -> Mail {
    let (lead, button, fallback, quiet) = match lang {
        MailLang::En => (
            format!("To finish signing up, confirm that {email} is your address."),
            "Confirm my address",
            "Button not working? Copy this link into your browser:",
            "This link is valid for 24 hours. Didn't create a Taido account? Ignore this message.",
        ),
        MailLang::Fr => (
            format!("Pour finir ton inscription, confirme que {email} est bien ton adresse."),
            "Confirmer mon adresse",
            "Le bouton ne marche pas ? Copie ce lien dans ton navigateur :",
            "Ce lien est valable 24 heures. Tu n'as pas créé de compte Taido ? Ignore ce message.",
        ),
    };
    let body = [
        tpl::paragraph(&lead),
        tpl::button(link, button),
        tpl::link_fallback(fallback, link),
        tpl::quiet(quiet),
    ]
    .concat();
    Mail {
        subject: verify_subject(lang).to_string(),
        text: format!("{lead} {link}\n\n{quiet}"),
        html: tpl::layout(
            lang.code(),
            lang.pick("Last step of your signup.", "Dernière étape de ton inscription."),
            verify_subject(lang),
            &body,
            lang.pick(
                "You are receiving this email because a Taido account was created with this address.",
                "Tu reçois ce mail parce qu'un compte Taido a été créé avec cette adresse.",
            ),
            public_url,
        ),
    }
}

/// Subject of the welcome e-mail.
pub fn welcome_subject(lang: MailLang) -> &'static str {
    lang.pick("Welcome to Taido", "Bienvenue dans Taido")
}

/// The welcome mail, sent once the address is confirmed: how to add the phone.
pub fn welcome_mail(email: &str, public_url: &str, lang: MailLang) -> Mail {
    let host = public_url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let (steps, lead, quiet, button, title) = match lang {
        MailLang::En => (
            [
                format!("On your phone, open {host}."),
                format!("Log in with {email}."),
                "Add the app to your home screen.".to_string(),
            ],
            "Your projects and tasks are now kept on your account. \
             Add your phone to find them everywhere.",
            "Taido also works in the browser of any computer, at the same address.",
            "Open Taido on your phone",
            "Your account is ready",
        ),
        MailLang::Fr => (
            [
                format!("Sur ton téléphone, ouvre {host}."),
                format!("Connecte-toi avec {email}."),
                "Ajoute l'appli à l'écran d'accueil.".to_string(),
            ],
            "Tes projets et tes tâches sont maintenant gardés sur ton compte. \
             Ajoute ton téléphone pour les retrouver partout.",
            "Taido marche aussi dans le navigateur de n'importe quel ordinateur, \
             à la même adresse.",
            "Ouvrir Taido sur le téléphone",
            "Ton compte est prêt",
        ),
    };
    let body = [
        tpl::paragraph(lead),
        tpl::steps(&steps),
        tpl::button(public_url, button),
        tpl::quiet(quiet),
    ]
    .concat();
    Mail {
        subject: welcome_subject(lang).to_string(),
        text: format!(
            "{title}. {lead}\n\n1. {}\n2. {}\n3. {}\n\n{quiet}",
            steps[0], steps[1], steps[2]
        ),
        html: tpl::layout(
            lang.code(),
            &format!("{title}."),
            title,
            &body,
            lang.pick(
                "You are receiving this email because a Taido account was created with this address.",
                "Tu reçois ce mail parce qu'un compte Taido a été créé avec cette adresse.",
            ),
            Some(public_url),
        ),
    }
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

    const EN: MailLang = MailLang::En;
    const FR: MailLang = MailLang::Fr;

    #[test]
    fn verify_mail_carries_the_link() {
        for lang in [EN, FR] {
            let link = confirm_link("https://taido.test", "abc_DEF-123");
            let mail = verify_mail("camille@example.com", &link, None, lang);
            assert_eq!(mail.subject, verify_subject(lang));
            assert_eq!(confirm_token_in(&mail.text).as_deref(), Some("abc_DEF-123"));
            assert!(mail
                .html
                .contains("href=\"https://taido.test/confirmer?t=abc_DEF-123\""));
            assert!(mail.html.contains("camille@example.com"));
        }
    }

    #[test]
    fn welcome_mail_explains_the_phone() {
        let mail = welcome_mail("camille@example.com", "https://taido.test", FR);
        assert_eq!(mail.subject, welcome_subject(FR));
        assert!(
            mail.text.contains("ouvre taido.test") && mail.text.contains("camille@example.com")
        );
        assert!(mail.html.contains("href=\"https://taido.test\""));
        assert!(mail.html.contains("Ton compte est prêt") && mail.html.contains(">3</td>"));
        let mail = welcome_mail("camille@example.com", "https://taido.test", EN);
        assert!(mail.text.contains("open taido.test") && mail.text.contains("camille@example.com"));
        assert!(mail.html.contains("Your account is ready") && mail.html.contains(">3</td>"));
    }

    #[test]
    fn mails_are_english_by_default() {
        assert_eq!(MailLang::default(), EN);
        let code = code_mail("042917", None, EN);
        assert_eq!(code.subject, "Your Taido code");
        assert_eq!(
            code.text,
            "Your code to change your password: 042917. It is valid for 30 minutes. \
             If you did not ask for it, ignore this message."
        );
        assert!(code.html.contains("Your code to change your password"));
        assert!(code.html.contains("<html lang=\"en\">"));
        let verify = verify_mail("c@example.com", "https://t.test/confirmer?t=a", None, EN);
        assert_eq!(verify.subject, "Confirm your address");
        assert!(verify
            .text
            .contains("confirm that c@example.com is your address"));
        assert!(verify.html.contains("Confirm my address"));
        let welcome = welcome_mail("c@example.com", "https://t.test", EN);
        assert_eq!(welcome.subject, "Welcome to Taido");
        assert!(welcome.html.contains("Open Taido on your phone"));
        for mail in [&code, &verify, &welcome] {
            for word in ["Ton ", "Tu ", "é", "à", "Taido marche"] {
                assert!(
                    !mail.text.contains(word) && !mail.subject.contains(word),
                    "{word}"
                );
            }
        }
    }

    #[test]
    fn mail_lang_fr_gives_french_mails() {
        let code = code_mail("042917", None, FR);
        assert_eq!(code.subject, "Ton code Taido");
        assert!(code
            .text
            .starts_with("Ton code pour changer de mot de passe : 042917."));
        assert!(code.html.contains("<html lang=\"fr\">"));
        let verify = verify_mail("c@example.com", "https://t.test/confirmer?t=a", None, FR);
        assert_eq!(verify.subject, "Confirme ton adresse");
        assert!(verify.html.contains("Confirmer mon adresse"));
        let welcome = welcome_mail("c@example.com", "https://t.test", FR);
        assert_eq!(welcome.subject, "Bienvenue dans Taido");
    }

    #[test]
    fn mail_lang_is_case_insensitive() {
        assert_eq!(MailLang::from_env_value(None).expect("unset"), EN);
        for (value, expected) in [
            ("", EN),
            ("  ", EN),
            ("en", EN),
            ("EN", EN),
            ("fr", FR),
            ("Fr", FR),
            (" FR ", FR),
        ] {
            assert_eq!(
                MailLang::from_env_value(Some(value)).expect(value),
                expected,
                "{value:?}"
            );
        }
    }

    #[test]
    fn invalid_mail_lang_is_refused() {
        for value in ["de", "english", "fr-FR", "1"] {
            let err = MailLang::from_env_value(Some(value)).expect_err(value);
            assert!(err.to_string().contains("TAIDO_MAIL_LANG"), "{err}");
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let value = std::ffi::OsString::from_vec(vec![0x66, 0xff]);
            let err = MailLang::from_os_value(Some(value)).expect_err("not unicode");
            assert!(err.to_string().contains("TAIDO_MAIL_LANG"), "{err}");
        }
        assert_eq!(MailLang::from_os_value(None).expect("unset"), EN);
    }

    #[test]
    fn mails_show_the_host_of_the_public_url_in_the_footer() {
        let url = Some("https://sync.example.com");
        for lang in [EN, FR] {
            for mail in [
                code_mail("042917", url, lang),
                verify_mail(
                    "c@example.com",
                    "https://sync.example.com/confirmer?t=a",
                    url,
                    lang,
                ),
                welcome_mail("c@example.com", "https://sync.example.com", lang),
            ] {
                assert!(mail.html.contains("<br>Taido · sync.example.com</td>"));
            }
            assert!(!code_mail("042917", None, lang).html.contains("Taido ·"));
        }
    }

    #[test]
    fn code_mail_has_both_parts() {
        let mail = code_mail("042917", None, FR);
        assert_eq!(mail.subject, code_subject(FR));
        assert_eq!(code_in(&mail.text).as_deref(), Some("042917"));
        assert!(mail.html.contains(">0</td>") && mail.html.contains(">7</td>"));
        assert!(mail.html.contains("Ton code pour changer de mot de passe"));
        assert_eq!(
            code_in(&code_mail("042917", None, EN).text).as_deref(),
            Some("042917")
        );
    }

    #[test]
    fn code_is_found_in_the_mail() {
        for lang in [EN, FR] {
            assert_eq!(
                code_in(&code_text("042917", lang)).as_deref(),
                Some("042917")
            );
        }
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
