#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mode = std::env::args().nth(1);
    let direct_askpass = mode.as_deref().is_some_and(|value| value != "editor")
        && std::env::var_os("GITTY_ASKPASS_PORT").is_some()
        && std::env::var_os("GITTY_ASKPASS_TOKEN").is_some();
    if mode.as_deref() == Some("askpass") || direct_askpass {
        std::process::exit(if run_askpass(mode.as_deref() == Some("askpass")).is_ok() {
            0
        } else {
            1
        });
    }
    if mode.as_deref() == Some("editor") {
        std::process::exit(if run_editor().is_ok() { 0 } else { 1 });
    }

    gitty_lib::run();
}

fn run_askpass(script: bool) -> std::io::Result<()> {
    let prompt = std::env::args()
        .nth(if script { 2 } else { 1 })
        .ok_or(std::io::ErrorKind::InvalidInput)?;
    let port = std::env::var("GITTY_ASKPASS_PORT")
        .map_err(|_| std::io::ErrorKind::InvalidInput)?
        .parse::<u16>()
        .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let token =
        std::env::var("GITTY_ASKPASS_TOKEN").map_err(|_| std::io::ErrorKind::InvalidInput)?;
    exchange_askpass(&prompt, port, &token, std::io::stdout())
}

fn exchange_askpass(
    prompt: &str,
    port: u16,
    token: &str,
    mut output: impl std::io::Write,
) -> std::io::Result<()> {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(5),
    )?;
    stream.set_read_timeout(Some(Duration::from_secs(95)))?;
    stream.write_all(format!("{token}\n{prompt}\n").as_bytes())?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    if response.first() != Some(&b'1') {
        return Err(std::io::ErrorKind::Interrupted.into());
    }
    output.write_all(&response[1..])
}

fn run_editor() -> std::io::Result<()> {
    let file_path = std::env::args()
        .nth(2)
        .ok_or(std::io::ErrorKind::InvalidInput)?;
    let port = std::env::var("GITTY_EDITOR_PORT")
        .map_err(|_| std::io::ErrorKind::InvalidInput)?
        .parse::<u16>()
        .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let token =
        std::env::var("GITTY_EDITOR_TOKEN").map_err(|_| std::io::ErrorKind::InvalidInput)?;
    exchange_editor(&file_path, port, &token)
}

fn exchange_editor(file_path: &str, port: u16, token: &str) -> std::io::Result<()> {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(5),
    )?;
    stream.set_read_timeout(Some(Duration::from_secs(100)))?;

    let token_bytes = token.as_bytes();
    let path_bytes = file_path.as_bytes();

    let mut message = Vec::with_capacity(8 + token_bytes.len() + path_bytes.len());
    message.extend_from_slice(&(token_bytes.len() as u32).to_be_bytes());
    message.extend_from_slice(token_bytes);
    message.extend_from_slice(&(path_bytes.len() as u32).to_be_bytes());
    message.extend_from_slice(path_bytes);

    stream.write_all(&message)?;

    let mut response = [0u8; 1];
    stream.read_exact(&mut response)?;
    if response[0] == b'1' {
        Ok(())
    } else {
        Err(std::io::ErrorKind::Interrupted.into())
    }
}

#[cfg(test)]
mod tests {
    use super::{exchange_askpass, exchange_editor};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    #[test]
    fn local_helper_preserves_answer_and_reports_cancel() {
        for (answer, succeeds) in [(b"1secret \n".as_slice(), true), (b"0".as_slice(), false)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(&stream);
                let mut token = String::new();
                let mut prompt = String::new();
                reader.read_line(&mut token).unwrap();
                reader.read_line(&mut prompt).unwrap();
                assert_eq!(token, "test-token\n");
                assert_eq!(prompt, "Password for example\n");
                stream.write_all(answer).unwrap();
            });
            let mut output = Vec::new();
            let result = exchange_askpass("Password for example", port, "test-token", &mut output);
            assert_eq!(result.is_ok(), succeeds);
            if succeeds {
                assert_eq!(output, b"secret \n");
            } else {
                assert!(output.is_empty());
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn local_editor_helper_sends_framed_path_and_handles_status() {
        for (reply_byte, succeeds) in [(b"1", true), (b"0", false)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut len_buf = [0u8; 4];
                stream.read_exact(&mut len_buf).unwrap();
                let token_len = u32::from_be_bytes(len_buf) as usize;
                let mut token = vec![0u8; token_len];
                stream.read_exact(&mut token).unwrap();
                assert_eq!(token, b"editor-token");

                stream.read_exact(&mut len_buf).unwrap();
                let path_len = u32::from_be_bytes(len_buf) as usize;
                let mut path = vec![0u8; path_len];
                stream.read_exact(&mut path).unwrap();
                assert_eq!(path, b"/tmp/repo/.git/COMMIT_EDITMSG");

                stream.write_all(reply_byte).unwrap();
            });

            let result = exchange_editor("/tmp/repo/.git/COMMIT_EDITMSG", port, "editor-token");
            assert_eq!(result.is_ok(), succeeds);
            server.join().unwrap();
        }
    }
}
