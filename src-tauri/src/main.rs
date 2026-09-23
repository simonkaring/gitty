#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("askpass") {
        std::process::exit(if run_askpass().is_ok() { 0 } else { 1 });
    }

    gitty_lib::run();
}

fn run_askpass() -> std::io::Result<()> {
    let prompt = std::env::args()
        .nth(2)
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

#[cfg(test)]
mod tests {
    use super::exchange_askpass;
    use std::io::{BufRead, BufReader, Write};
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
}
