"""Shutdown must reclaim clients that never finish sending their headers."""
from pathlib import Path
import socket, sys, threading, time, unittest
from http.server import BaseHTTPRequestHandler
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'铺面查看器/player'))
from server import BoundedHTTPServer
class Shutdown(unittest.TestCase):
 def test_idle_clients_are_closed_and_slots_released(self):
  server=BoundedHTTPServer(('127.0.0.1',0),BaseHTTPRequestHandler)
  thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  client=socket.create_connection(server.server_address);client.settimeout(2)
  try:
   deadline=time.monotonic()+2
   while not server.connections and time.monotonic()<deadline: time.sleep(.005)
   self.assertEqual(len(server.connections),1)
   server.shutdown();server.server_close();self.assertEqual(client.recv(1),b'')
   deadline=time.monotonic()+2
   while server.connections and time.monotonic()<deadline: time.sleep(.005)
   self.assertFalse(server.connections)
   slots=0
   while server.slots.acquire(blocking=False): slots+=1
   self.assertEqual(slots,48)
  finally: client.close();server.shutdown();server.server_close();thread.join(2)
if __name__=='__main__': unittest.main()
