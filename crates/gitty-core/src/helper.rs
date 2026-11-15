use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    time::Duration,
};

pub fn run_askpass(
    prompt: &str,
    port: u16,
    token: &str,
    output: impl Write,
) -> std::io::Result<()> {
    let mut stream = connect(port, Duration::from_secs(95))?;
    stream.write_all(format!("{token}\n{prompt}\n").as_bytes())?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    if response.first() != Some(&b'1') {
        return Err(std::io::ErrorKind::Interrupted.into());
    }
    let mut output = output;
    output.write_all(&response[1..])
}

pub fn run_editor(file_path: &str, port: u16, token: &str) -> std::io::Result<()> {
    let mut stream = connect(port, Duration::from_secs(100))?;
    let token = token.as_bytes();
    let path = file_path.as_bytes();
    let mut message = Vec::with_capacity(8 + token.len() + path.len());
    message.extend_from_slice(&(token.len() as u32).to_be_bytes());
    message.extend_from_slice(token);
    message.extend_from_slice(&(path.len() as u32).to_be_bytes());
    message.extend_from_slice(path);
    stream.write_all(&message)?;
    let mut response = [0u8; 1];
    stream.read_exact(&mut response)?;
    if response[0] == b'1' {
        Ok(())
    } else {
        Err(std::io::ErrorKind::Interrupted.into())
    }
}

fn connect(port: u16, timeout: Duration) -> std::io::Result<TcpStream> {
    let stream = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(5),
    )?;
    stream.set_read_timeout(Some(timeout))?;
    Ok(stream)
}

pub fn askpass_from_env(args: &[String]) -> std::io::Result<()> {
    let script = args.first().map(String::as_str) == Some("askpass");
    let prompt_index = if script { 1 } else { 0 };
    let prompt = args
        .get(prompt_index)
        .ok_or(std::io::ErrorKind::InvalidInput)?;
    let port = std::env::var("GITTY_ASKPASS_PORT")
        .map_err(|_| std::io::ErrorKind::InvalidInput)?
        .parse::<u16>()
        .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let token =
        std::env::var("GITTY_ASKPASS_TOKEN").map_err(|_| std::io::ErrorKind::InvalidInput)?;
    run_askpass(prompt, port, &token, std::io::stdout())
}

pub fn editor_from_env(args: &[String]) -> std::io::Result<()> {
    let file_path = args.get(1).ok_or(std::io::ErrorKind::InvalidInput)?;
    let port = std::env::var("GITTY_EDITOR_PORT")
        .map_err(|_| std::io::ErrorKind::InvalidInput)?
        .parse::<u16>()
        .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let token =
        std::env::var("GITTY_EDITOR_TOKEN").map_err(|_| std::io::ErrorKind::InvalidInput)?;
    run_editor(file_path, port, &token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn askpass_roundtrip_preserves_secret_without_logging_it() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut token = String::new();
            let mut prompt = String::new();
            reader.read_line(&mut token).unwrap();
            reader.read_line(&mut prompt).unwrap();
            assert_eq!(token, "scoped-token\n");
            assert_eq!(prompt, "Password prompt\n");
            stream.write_all(b"1secret-value \n").unwrap();
        });
        let mut output = Vec::new();
        run_askpass("Password prompt", port, "scoped-token", &mut output).unwrap();
        assert_eq!(output, b"secret-value \n");
        server.join().unwrap();
    }
}
