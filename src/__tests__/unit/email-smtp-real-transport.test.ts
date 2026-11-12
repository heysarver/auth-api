/**
 * Behavioural test for the real SMTP transport in lib/email.ts.
 *
 * The sibling email.test.ts replaces nodemailer with a mock, so it proves only
 * that sendEmail forwards its arguments. It cannot prove that the transport
 * options this service passes are still accepted, and that a message is still
 * framed correctly, by the installed nodemailer major. This file runs the real
 * library against a minimal local SMTP sink, so a breaking change in the SMTP
 * client (nodemailer 9 -> 10 was such a change) fails here instead of in
 * production mail delivery.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";

interface Sink {
  port: number;
  transcript: string[];
  messages: string[];
  close: () => Promise<void>;
}

function startSink(): Promise<Sink> {
  return new Promise((resolve) => {
    const transcript: string[] = [];
    const messages: string[] = [];
    const server = net.createServer((sock) => {
      let inData = false;
      let buf = "";
      let current: string[] = [];
      sock.write("220 sink.local ESMTP\r\n");
      sock.on("error", () => {});
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              messages.push(current.join("\r\n"));
              current = [];
              sock.write("250 2.0.0 Ok: queued\r\n");
            } else {
              current.push(line);
            }
            continue;
          }
          transcript.push(line);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO") sock.write("250-sink.local\r\n250 8BITMIME\r\n");
          else if (cmd === "HELO") sock.write("250 sink.local\r\n");
          else if (cmd === "DATA") {
            inData = true;
            sock.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (cmd === "QUIT") {
            sock.write("221 Bye\r\n");
            sock.end();
          } else sock.write("250 Ok\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        transcript,
        messages,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

describe("lib/email.ts real SMTP transport", () => {
  let sink: Sink;
  let sendEmail: (options: {
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }) => Promise<void>;

  beforeAll(async () => {
    sink = await startSink();
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(sink.port);
    process.env.SMTP_FROM = "noreply@example.com";
    delete process.env.SENDGRID_API_KEY;
    // EMAIL_CONFIG and the transport are built at module load, so the module
    // is imported only after the environment points at the sink.
    vi.resetModules();
    ({ sendEmail } = await import("../../lib/email.js"));
  });

  afterAll(async () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_FROM;
    await sink.close();
  });

  it("delivers a message through the real nodemailer transport", async () => {
    await sendEmail({
      to: "andrew@example.com",
      subject: "transport proof",
      text: "plain body",
      html: "<p>html body</p>",
    });

    expect(sink.transcript.some((l) => l.startsWith("MAIL FROM:"))).toBe(true);
    expect(sink.messages).toHaveLength(1);

    const message = sink.messages[0];
    expect(message).toContain("From: noreply@example.com");
    expect(message).toContain("To: andrew@example.com");
    expect(message).toContain("Subject: transport proof");
    expect(message).toContain("Content-Type: multipart/alternative");
    expect(message).toContain("plain body");
    expect(message).toContain("<p>html body</p>");
  });

  it("keeps the timeout options accepted by the installed nodemailer", async () => {
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port: sink.port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5000,
      socketTimeout: 5000,
    });
    expect(typeof transport.sendMail).toBe("function");
    transport.close();
  });
});
