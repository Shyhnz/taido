//! HTML layout of the e-mails ("Bleu nuit" direction, chosen 2026-10-12): navy band with the
//! logo and the title, white card, centred footer. Tables and inline styles only, so that
//! Gmail, Outlook and Apple Mail render it the same; the logo is an inline image
//! ([`LOGO_CID`]) sent with the mail, never fetched from the network.

/// Content-ID of the logo attached to every HTML mail.
pub const LOGO_CID: &str = "taido-logo";

/// The logo (96 × 96 PNG, shown at 28 px).
pub const LOGO_PNG: &[u8] = include_bytes!("../assets/mail-logo.png");

const FONT: &str = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

/// Escapes text for HTML content and attribute values.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// A paragraph of the card body (`text` is escaped).
pub fn paragraph(text: &str) -> String {
    format!(
        "<p style=\"margin:0 0 14px;font-family:{FONT};font-size:15px;line-height:1.55;color:#3c4562;\">{}</p>",
        escape(text)
    )
}

/// The closing note of the card, above a hairline (`text` is escaped).
pub fn quiet(text: &str) -> String {
    format!(
        "<p style=\"margin:8px 0 0;padding-top:16px;border-top:1px solid #e3e8f4;font-family:{FONT};font-size:13.5px;line-height:1.55;color:#69708a;\">{}</p>",
        escape(text)
    )
}

/// A code shown digit by digit in boxes, a gap after the third digit, then `caption`.
pub fn code_boxes(code: &str, caption: &str) -> String {
    let mut cells = String::new();
    for (i, digit) in code.chars().enumerate() {
        if i > 0 {
            let gap = if i == 3 { 12 } else { 5 };
            cells.push_str(&format!("<td style=\"width:{gap}px;\">&nbsp;</td>"));
        }
        cells.push_str(&format!(
            "<td align=\"center\" valign=\"middle\" width=\"38\" height=\"54\" bgcolor=\"#eef2fc\" style=\"width:38px;height:54px;background:#eef2fc;border:1px solid #cdd7f3;border-radius:10px;font-family:{FONT};font-size:26px;font-weight:700;color:#142a78;\">{}</td>",
            escape(&digit.to_string())
        ));
    }
    format!(
        "<table role=\"presentation\" align=\"center\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:6px auto 10px;border-collapse:separate;\"><tr>{cells}</tr></table>\
         <p style=\"margin:0 0 14px;text-align:center;font-family:{FONT};font-size:13.5px;color:#69708a;\">{}</p>",
        escape(caption)
    )
}

/// Numbered steps, one per row, each number in a navy dot (`steps` are escaped).
pub fn steps(steps: &[String]) -> String {
    let rows: String = steps
        .iter()
        .enumerate()
        .map(|(i, step)| {
            format!(
                "<tr><td valign=\"top\" width=\"34\" style=\"width:34px;padding:0 0 12px;\">\
                 <table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr>\
                 <td align=\"center\" valign=\"middle\" width=\"24\" height=\"24\" bgcolor=\"#142a78\" style=\"width:24px;height:24px;background:#142a78;border-radius:12px;font-family:{FONT};font-size:12.5px;font-weight:700;color:#ffffff;\">{}</td>\
                 </tr></table></td>\
                 <td valign=\"top\" style=\"padding:2px 0 12px;font-family:{FONT};font-size:15px;line-height:1.45;color:#3c4562;\">{}</td></tr>",
                i + 1,
                escape(step)
            )
        })
        .collect();
    format!(
        "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:4px 0 8px;\">{rows}</table>"
    )
}

/// A light box of label / value rows, e.g. the details of a plan (`rows` are escaped).
pub fn rows(rows: &[(&str, String)]) -> String {
    let body: String = rows
        .iter()
        .enumerate()
        .map(|(i, (label, value))| {
            let border = if i == 0 { "" } else { "border-top:1px solid #dfe5f3;" };
            format!(
                "<tr><td style=\"padding:11px 14px;{border}font-family:{FONT};font-size:14px;color:#69708a;\">{}</td>\
                 <td align=\"right\" style=\"padding:11px 14px;{border}font-family:{FONT};font-size:14px;font-weight:600;color:#142a78;\">{}</td></tr>",
                escape(label),
                escape(value)
            )
        })
        .collect();
    format!(
        "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" bgcolor=\"#f4f6fc\" style=\"margin:4px 0 18px;background:#f4f6fc;border:1px solid #dfe5f3;border-radius:10px;border-collapse:separate;\">{body}</table>"
    )
}

/// A full-width button linking to `url` (`label` and `url` are escaped).
pub fn button(url: &str, label: &str) -> String {
    format!(
        "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:8px 0 18px;\"><tr>\
         <td align=\"center\" bgcolor=\"#142a78\" style=\"background:#142a78;border-radius:10px;\">\
         <a href=\"{}\" style=\"display:block;padding:14px 20px;font-family:{FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;\">{}</a>\
         </td></tr></table>",
        escape(url),
        escape(label)
    )
}

/// A small line showing `url` as text, for when the button does not open (`url` is escaped).
pub fn link_fallback(intro: &str, url: &str) -> String {
    format!(
        "<p style=\"margin:0 0 14px;font-family:{FONT};font-size:12.5px;line-height:1.5;color:#69708a;word-break:break-all;\">{}<br><a href=\"{url}\" style=\"color:#142a78;\">{url}</a></p>",
        escape(intro),
        url = escape(url)
    )
}

/// The `host[:port]` of a public URL (`https://sync.example.com/taido/` gives
/// `sync.example.com`): no scheme, path, query or fragment.
fn host_of(public_url: &str) -> &str {
    let rest = public_url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    rest.split(['/', '?', '#']).next().unwrap_or("")
}

/// The whole HTML document. `preheader`, `title` and `footer` are escaped; `body` is HTML
/// built with the helpers above. The last footer line names the server by the host of
/// `public_url` (`TAIDO_PUBLIC_URL`); without one it only says "Taido".
pub fn layout(
    preheader: &str,
    title: &str,
    body: &str,
    footer: &str,
    public_url: Option<&str>,
) -> String {
    let sign = match public_url.map(host_of).filter(|h| !h.is_empty()) {
        Some(host) => format!("Taido · {}", escape(host)),
        None => "Taido".to_string(),
    };
    let preheader = escape(preheader);
    let title = escape(title);
    let footer = escape(footer);
    format!(
        r##"<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>{title}</title>
</head>
<body style="margin:0;padding:0;background:#e8ecf6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#e8ecf6;">{preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#e8ecf6" style="background:#e8ecf6;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td bgcolor="#142a78" style="background:#142a78;background-image:linear-gradient(160deg,#2242a0 0%,#0c1a4c 100%);padding:28px 24px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="padding-right:10px;"><img src="cid:{LOGO_CID}" width="28" height="28" alt="" style="display:block;border:0;"></td>
<td valign="middle" style="font-family:{FONT};font-size:16px;font-weight:600;color:#d5def6;">Taido</td>
</tr></table>
<h1 style="margin:22px 0 0;font-family:{FONT};font-size:24px;line-height:1.2;font-weight:700;color:#ffffff;">{title}</h1>
</td></tr>
<tr><td style="padding:24px 22px 26px;">
{body}
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
<tr><td align="center" style="padding:16px 8px 0;font-family:{FONT};font-size:12px;line-height:1.6;color:#7b839c;">{footer}<br>{sign}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
"##
    )
}

/// A web page of the server (address confirmation) in the same style: the logo is a `data:`
/// image (allowed by the page's CSP), no script. `title` is escaped; `body` is HTML built with
/// the helpers above.
pub fn page(title: &str, body: &str) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let logo = format!("data:image/png;base64,{}", STANDARD.encode(LOGO_PNG));
    let html = layout("", title, body, "", None);
    html.replace(&format!("cid:{LOGO_CID}"), &logo)
        .replace("<br>Taido</td>", "Taido</td>")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn footer_host_drops_path() {
        assert_eq!(
            host_of("https://sync.example.com/taido/"),
            "sync.example.com"
        );
        assert_eq!(
            host_of("https://sync.example.com/a?x=1#top"),
            "sync.example.com"
        );
        assert_eq!(host_of("sync.example.com/"), "sync.example.com");
    }

    #[test]
    fn footer_host_keeps_port() {
        assert_eq!(host_of("http://127.0.0.1:3020"), "127.0.0.1:3020");
        assert_eq!(host_of("http://127.0.0.1:3020/x"), "127.0.0.1:3020");
    }

    #[test]
    fn text_is_escaped() {
        assert_eq!(
            escape("<a href=\"x\">&'"),
            "&lt;a href=&quot;x&quot;&gt;&amp;&#39;"
        );
        let html = layout("<p>", "<t>", "", "<f>", None);
        assert!(!html.contains("<p>") && !html.contains("<t>") && !html.contains("<f>"));
    }

    #[test]
    fn code_boxes_hold_each_digit() {
        let html = code_boxes("482913", "Valable 30 minutes");
        for digit in ["4", "8", "2", "9", "1", "3"] {
            assert!(html.contains(&format!(">{digit}</td>")), "{digit}");
        }
        assert!(html.contains("Valable 30 minutes"));
    }

    #[test]
    fn mail_footer_without_public_url_has_no_domain() {
        let html = layout("p", "t", "b", "f", None);
        assert!(html.contains("f<br>Taido</td>"));
        assert!(!html.contains("Taido ·"));
        assert!(!html.contains("example.com"));
    }

    #[test]
    fn mail_footer_uses_public_url_host() {
        let html = layout("p", "t", "b", "f", Some("https://sync.example.com/"));
        assert!(html.contains("<br>Taido · sync.example.com</td>"));
        assert!(!html.contains("https://sync.example.com"));
        let plain = layout("p", "t", "b", "f", Some("http://127.0.0.1:3020"));
        assert!(plain.contains("<br>Taido · 127.0.0.1:3020</td>"));
    }

    #[test]
    fn layout_points_to_the_inline_logo() {
        assert!(layout("p", "t", "b", "f", None).contains("src=\"cid:taido-logo\""));
        assert_eq!(&LOGO_PNG[1..4], b"PNG");
    }
}
