import http from "node:http";
import https from "node:https";
import net from "node:net";

function denied() {
  throw new Error("network access is forbidden in this test");
}

net.connect = denied;
net.createConnection = denied;
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
globalThis.fetch = denied;
