// Stands in for the service that says whether a caller may read a dataset.
// The answer is chosen by the token, so that each test decides its own:
//
//   allow-<anything>   200
//   allow-nostore-<anything>   200, asking that the answer not be kept
//   allow-slow-<anything>   200, after a wait long enough for requests sent
//                           together to overlap
//   deny-401, deny-403, deny-404, fail-500, fail-503   that status
//   no token           403, except for the forms listed in PUBLIC_FORMS
//
// A caller carrying SIGNED_IN as a cookie is approved, as a service that
// authenticates by cookie would approve one.
//
// GET /__requests lists what was asked; DELETE /__requests forgets it.
const http = require("node:http");

const PUBLIC_FORMS = ["/api/v1/forms/3.json"];
const SIGNED_IN = "sessionid=signed-in";
const SLOW_MS = 300;

let requests = [];

const statusFor = (url, authorization, cookie) => {
    if (String(cookie).includes(SIGNED_IN)) {
        return 200;
    }
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

const NOT_TO_BE_KEPT = {
    "Cache-Control": "private, no-store, max-age=0",
    "Set-Cookie": "sessionid=given-out; Path=/",
    Vary: "Cookie, Accept-Encoding",
};

const answer = (response, status, body, headers = {}) => {
    response.writeHead(status, {
        "Content-Type": "application/json",
        ...headers,
    });
    response.end(JSON.stringify(body));
};

http.createServer((request, response) => {
    if (request.url === "/__requests") {
        if (request.method === "DELETE") {
            requests = [];
        }
        return answer(response, 200, requests);
    }
    const { method, url, headers } = request;
    const { authorization } = headers;
    requests = [...requests, { method, url, authorization, headers }];
    const wait = String(authorization).includes("allow-slow-") ? SLOW_MS : 0;
    return setTimeout(
        () =>
            answer(
                response,
                statusFor(url, authorization, headers.cookie),
                {},
                String(authorization).includes("allow-nostore-")
                    ? NOT_TO_BE_KEPT
                    : {},
            ),
        wait,
    );
}).listen(8000, "0.0.0.0");
