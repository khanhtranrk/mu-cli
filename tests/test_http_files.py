"""Binary HTTP transfers: raw bytes, atomic replacement and failure preservation."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mu.runtime import run_action


class HttpFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = bytes(range(256)) * 8193
        payload = self.payload
        self.uploads = []
        uploads = self.uploads

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                uploads.append((self.rfile.read(int(self.headers['Content-Length'])), dict(self.headers)))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'storageId': 'file'}).encode())

            def do_GET(self):
                if self.path == '/error':
                    self.send_response(401)
                    self.end_headers()
                    self.wfile.write(b'{"error":"Unauthorized"}')
                    return
                self.send_response(200)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload[:100] if self.path == '/truncated' else payload)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.context = {}

    def action(self, **values):
        run_action({'type': 'send_http_request', 'url': self.url, 'save_state': 'transfer', **values},
                   self.context, {}, self.root)
        return self.context['actions']['transfer']

    def test_binary_upload_and_download(self):
        (self.root / 'source.bin').write_bytes(self.payload)
        result = self.action(method='post', body_file='source.bin', timeout=120,
                             header={'Content-Length': '1', 'Transfer-Encoding': 'chunked'})
        self.assertEqual(self.uploads[0][0], self.payload)
        self.assertEqual(self.uploads[0][1]['Content-Length'], str(len(self.payload)))
        self.assertNotIn('Transfer-Encoding', self.uploads[0][1])
        self.assertEqual(self.uploads[0][1]['Content-Type'], 'application/octet-stream')
        self.assertEqual(result['body'], {'storageId': 'file'})
        result = self.action(response_file='nested/download.bin')
        self.assertEqual((self.root / 'nested/download.bin').read_bytes(), self.payload)
        self.assertIsNone(result['body'])
        self.assertEqual(result['size'], len(self.payload))
        self.assertEqual(result['response_file'], str(self.root / 'nested/download.bin'))
        self.assertFalse(list(self.root.glob('nested/.mu-download-*')))

    def test_failed_download_preserves_existing_file(self):
        destination = self.root / 'keep.bin'
        destination.write_bytes(b'existing')
        for path in ['/error', '/truncated']:
            with self.assertRaises(ValueError):
                self.action(url=self.url + path, response_file='keep.bin')
            self.assertEqual(destination.read_bytes(), b'existing')
            self.assertFalse(list(self.root.glob('.mu-download-*')))
            self.assertFalse(self.context['actions']['transfer']['success'])
        self.action(url=self.url + '/error', response_file='keep.bin', ignore_error=True)
        self.assertEqual(self.context['actions']['transfer']['body'], {'error': 'Unauthorized'})
        self.assertEqual(destination.read_bytes(), b'existing')

    def test_invalid_declarations_and_json_compatibility(self):
        for values in [{'body': {}, 'body_file': 'source.bin'}, {'timeout': 0}, {'timeout': True},
                       {'timeout': float('nan')}, {'body_file': ''}, {'response_file': False}]:
            with self.assertRaises(ValueError):
                self.action(**values)
        self.assertEqual(self.uploads, [])
        result = self.action(method='post', body={'message': 'hello'})
        self.assertEqual(json.loads(self.uploads[0][0]), {'message': 'hello'})
        self.assertEqual(result['body'], {'storageId': 'file'})


if __name__ == '__main__':
    unittest.main()
