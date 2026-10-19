import { describe, it, expect } from 'vitest';
import nodemailer from 'nodemailer';
import { createRequire } from 'node:module';
import net from 'node:net';
const require = createRequire(import.meta.url);

describe('reviewed Nodemailer production contract', () => {
  it('uses the reviewed patched parser and transport build', () => {
    expect(require('nodemailer/package.json').version).toBe('10.0.16');
  });
  it('delivers the actual sendMail shape through bounded loopback SMTP', async () => {
    let received = '';
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      socket.write('220 fixture ESMTP\r\n');
      let pending = ''; let data = false;
      socket.on('data', chunk => {
        pending += chunk.toString();
        while (pending.includes('\r\n')) {
          const at = pending.indexOf('\r\n'); const line = pending.slice(0, at); pending = pending.slice(at + 2);
          if (data) {
            if (line === '.') { data = false; socket.write('250 queued\r\n'); }
            else received += line + '\r\n';
          } else if (/^EHLO/.test(line)) socket.write('250-fixture\r\n250 SIZE 100000\r\n');
          else if (/^DATA/.test(line)) { data = true; socket.write('354 send data\r\n'); }
          else if (/^QUIT/.test(line)) socket.end('221 bye\r\n');
          else socket.write('250 OK\r\n');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const transport = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, connectionTimeout: 2000, socketTimeout: 2000 });
    try {
      const result = await transport.sendMail({ from: 'noreply@example.test', to: 'owner@example.test', subject: 'Verification', text: 'bounded test', html: '<p>bounded test</p>' });
      expect(result.accepted).toEqual(['owner@example.test']);
      expect(received).toContain('Subject: Verification');
      expect(received).toContain('bounded test');
    } finally {
      transport.close(); for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
