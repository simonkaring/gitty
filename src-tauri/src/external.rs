use crate::dto::{Error, Result};

fn validated_url(value: &str) -> Result<url::Url> {
    if value.len() > 8192
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
        || value.contains('\\')
    {
        return Err(Error::new(
            "invalidUrl",
            "Expected an HTTPS URL without whitespace or credentials.",
        ));
    }
    let url = url::Url::parse(value).map_err(|_| Error::new("invalidUrl", "Invalid URL"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || value.split('/').nth(2).is_some_and(|s| s.contains('@'))
    {
        return Err(Error::new(
            "invalidUrl",
            "Only HTTPS URLs without embedded credentials can be opened.",
        ));
    }
    Ok(url)
}
pub fn open_url(value: &str) -> Result<()> {
    let url = validated_url(value)?;
    open::that_detached(url.as_str()).map_err(|e| Error::new("openExternal", e.to_string()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_external_links() {
        for value in [
            "file:///etc/passwd",
            "http://example.com",
            "https://user@example.com",
            "https://:pass@example.com",
            "https://@example.com",
            "https://example.com\n",
            "https://example.com\\@other.com",
        ] {
            assert!(validated_url(value).is_err(), "{value}");
        }
        assert!(validated_url("https://example.com/org/repo/pull/1?q=hello%20world").is_ok());
    }
}
