import http.server, sys, functools
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()
    def log_message(self, fmt, *args):
        sys.stderr.write("R2 " + (fmt % args) + "\n"); sys.stderr.flush()
http.server.ThreadingHTTPServer(("127.0.0.1", 4180), functools.partial(H, directory=sys.argv[1])).serve_forever()
