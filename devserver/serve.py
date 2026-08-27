"""Serve the site over HTTPS for local testing.

The Spotify dashboard rejects http:// redirect URIs outright -- including
loopback addresses -- so the converter's OAuth flow can't be tested against
`python -m http.server`. This serves the repo with the self-signed cert sitting
next to this file; register https://127.0.0.1:8443/converter.html as a redirect
URI on the Spotify app, and click through Chrome's certificate warning once.

    python devserver/serve.py [root] [port]
"""

import http.server
import os
import ssl
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(HERE)
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8443

CERT = os.path.join(HERE, "cert.pem")
KEY = os.path.join(HERE, "key.pem")

# The cert and key are gitignored, so a fresh clone has to make its own.
if not (os.path.exists(CERT) and os.path.exists(KEY)):
    sys.exit(
        "Missing cert.pem/key.pem in %s\n\nGenerate them with:\n"
        '  openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \\n'
        '    -days 825 -subj "//CN=127.0.0.1" \\n'
        '    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"' % HERE
    )

os.chdir(ROOT)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(CERT, KEY)

httpd = http.server.HTTPServer(("127.0.0.1", PORT), http.server.SimpleHTTPRequestHandler)
httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

print("serving %s at https://127.0.0.1:%d/" % (os.path.abspath(ROOT), PORT), flush=True)
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    print("")
