const { execFileSync } = require("node:child_process");
const http = require("node:http");
const zlib = require("node:zlib");

const SIDECAR = process.env.SIDECAR_URL;
const TILE_SERVER = process.env.TILE_SERVER_URL;
const PERMISSIONS = process.env.PERMISSIONS_URL;
const PROXY_CONTAINER = process.env.PROXY_CONTAINER;

const ALLOWED_ORIGIN = "https://first.example.test";
const OTHER_ALLOWED_ORIGIN = "https://second.example.test";

const request = (base, path, { method = "GET", headers = {} } = {}) =>
    new Promise((resolve, reject) => {
        const sent = http.request(
            `${base}${path}`,
            { method, headers, agent: false },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () =>
                    resolve({
                        status: response.statusCode,
                        headers: response.headers,
                        body: Buffer.concat(chunks),
                        cache: response.headers["x-cache-status"],
                    }),
                );
            },
        );
        sent.on("error", reject);
        sent.end();
    });

const throughSidecar = (path, options) => request(SIDECAR, path, options);

const fromTileServer = (path, options) => request(TILE_SERVER, path, options);

const compressed = { headers: { "accept-encoding": "gzip" } };

const contentOf = ({ headers, body }) =>
    headers["content-encoding"] === "gzip" ? zlib.gunzipSync(body) : body;

const permissionRequests = async () =>
    JSON.parse((await request(PERMISSIONS, "/__requests")).body);

const forgetPermissionRequests = () =>
    request(PERMISSIONS, "/__requests", { method: "DELETE" });

const proxyLog = () =>
    execFileSync("docker", ["logs", PROXY_CONTAINER], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

// Each test asks as a caller of its own, so that what one test made the
// sidecar remember about a caller cannot decide another test's outcome.
let callers = 0;
const newCaller = (kind = "allow") => {
    callers += 1;
    return `${kind}-${process.pid}-${callers}`;
};

// Tiles of zoom 14 that hold nothing, one for each test that needs a tile
// nobody has asked for yet.
let tiles = 0;
const unusedEmptyTile = () => {
    tiles += 1;
    return `/v1/mvt/14/${tiles}/1`;
};

module.exports = {
    ALLOWED_ORIGIN,
    OTHER_ALLOWED_ORIGIN,
    throughSidecar,
    fromTileServer,
    compressed,
    contentOf,
    permissionRequests,
    forgetPermissionRequests,
    proxyLog,
    newCaller,
    unusedEmptyTile,
};
