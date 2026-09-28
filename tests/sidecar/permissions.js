// Stands in for the service that says whether a caller may read a dataset.
// The answer is chosen by the token, so that each test decides its own:
//
//   allow-<anything>   200
//   allow-slow-<anything>   200, after a wait long enough for requests sent
//                           together to overlap
//   deny-401, deny-403, deny-404, fail-500, fail-503   that status
//   no token           403, except for the forms listed in PUBLIC_FORMS
//
// GET /__requests lists what was asked; DELETE /__requests forgets it.
const http = require("node:http");

const PUBLIC_FORMS = ["/api/v1/forms/3.json"];
const SLOW_MS = 300;

let requests = [];

const statusFor = (url, authorization) => {
    if (authorization === undefined) {
        return PUBLIC_FORMS.includes(url) ? 200 : 403;
    }
    const token = authorization.replace(/^TempToken /, "");
    const chosen = token.match(/^(?:deny|fail)-(\d{3})/);
    if (chosen) {
        return Number(chosen[1]);
    }
    return token.startsWith("allow-") ? 200 : 403;
};

const answer = (response, status, body) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
};

http.createServer((request, response) => {
    if (request.url === "/__requests") {
        if (request.method === "DELETE") {
            requests = [];
        }
        return answer(response, 200, requests);
    }
    const { method, url } = request;
    const { authorization } = request.headers;
    requests = [...requests, { method, url, authorization }];
    const wait = String(authorization).includes("allow-slow-") ? SLOW_MS : 0;
    return setTimeout(
        () => answer(response, statusFor(url, authorization), {}),
        wait,
    );
}).listen(8000, "0.0.0.0");
