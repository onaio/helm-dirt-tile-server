const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
    throughSidecar,
    permissionRequests,
    forgetPermissionRequests,
    newCaller,
    unusedEmptyTile,
} = require("./helpers");

const WORLD = "/v1/mvt/0/0/0";

// The tile server asks for itself as well, with GET, whenever a request
// reaches it. Only what the sidecar asked is of interest here.
const askedBySidecar = async () =>
    (await permissionRequests()).filter(({ method }) => method === "HEAD");

const asAsked = async () =>
    (await askedBySidecar()).map(({ method, url, authorization }) => ({
        method,
        url,
        authorization,
    }));

describe("permission", () => {
    beforeEach(forgetPermissionRequests);

    const datasets = [
        ["form_id=1", "/api/v1/forms/1.json"],
        ["dataview_id=10", "/api/v1/dataviews/10.json"],
        ["merged_dataset_id=50", "/api/v1/merged-datasets/50.json"],
    ];

    for (const [dataset, asked] of datasets) {
        test(`${dataset} is asked about at ${asked}, with the caller's token`, async () => {
            const caller = newCaller();

            const response = await throughSidecar(
                `${WORLD}?${dataset}&temp_token=${caller}`,
            );

            assert.equal(response.status, 200);
            assert.deepEqual(await asAsked(), [
                {
                    method: "HEAD",
                    url: asked,
                    authorization: `TempToken ${caller}`,
                },
            ]);
        });
    }

    test("a caller without a token is asked about without one", async () => {
        const response = await throughSidecar(`${WORLD}?form_id=3`);

        assert.equal(response.status, 204);
        assert.deepEqual(await asAsked(), [
            {
                method: "HEAD",
                url: "/api/v1/forms/3.json",
                authorization: undefined,
            },
        ]);
    });

    test("a caller without a token gets nothing that is not public", async () => {
        const response = await throughSidecar(`${WORLD}?form_id=1`);

        assert.equal(response.status, 403);
        assert.equal(response.headers["content-type"].includes("protobuf"), false);
    });

    const refusals = [
        ["deny-401", 401],
        ["deny-403", 403],
        ["deny-404", 403],
        ["fail-500", 500],
        ["fail-503", 500],
    ];

    for (const [kind, status] of refusals) {
        test(`a caller answered ${kind} gets a ${status} and no tile`, async () => {
            const response = await throughSidecar(
                `${WORLD}?form_id=1&temp_token=${newCaller(kind)}`,
            );

            assert.equal(response.status, status);
            assert.equal(
                String(response.headers["content-type"]).includes("protobuf"),
                false,
            );
        });
    }

    test("an approval is remembered for the caller's next request", async () => {
        const caller = newCaller();

        await throughSidecar(`${unusedEmptyTile()}?form_id=1&temp_token=${caller}`);
        await throughSidecar(`${unusedEmptyTile()}?form_id=1&temp_token=${caller}`);

        assert.equal((await askedBySidecar()).length, 1);
    });

    test("a refusal is remembered for the caller's next request", async () => {
        const caller = newCaller("deny-403");

        const first = await throughSidecar(`${WORLD}?form_id=1&temp_token=${caller}`);
        const second = await throughSidecar(`${WORLD}?form_id=1&temp_token=${caller}`);

        assert.deepEqual([first.status, second.status], [403, 403]);
        assert.equal((await askedBySidecar()).length, 1);
    });

    test("a failure to ask is not remembered", async () => {
        const caller = newCaller("fail-500");

        await throughSidecar(`${WORLD}?form_id=1&temp_token=${caller}`);
        await throughSidecar(`${WORLD}?form_id=1&temp_token=${caller}`);

        assert.equal((await askedBySidecar()).length, 2);
    });

    test("one caller's approval does not admit another", async () => {
        const allowed = newCaller();
        const refused = newCaller("deny-403");

        const first = await throughSidecar(`${WORLD}?form_id=1&temp_token=${allowed}`);
        const second = await throughSidecar(`${WORLD}?form_id=1&temp_token=${refused}`);
        const third = await throughSidecar(`${WORLD}?form_id=1`);

        assert.deepEqual(
            [first.status, second.status, third.status],
            [200, 403, 403],
        );
    });

    test("an approval for one dataset does not cover another", async () => {
        const caller = newCaller();

        await throughSidecar(`${WORLD}?form_id=1&temp_token=${caller}`);
        await throughSidecar(`${WORLD}?form_id=2&temp_token=${caller}`);
        await throughSidecar(`${WORLD}?dataview_id=1&temp_token=${caller}`);

        assert.deepEqual(
            (await askedBySidecar()).map(({ url }) => url),
            [
                "/api/v1/forms/1.json",
                "/api/v1/forms/2.json",
                "/api/v1/dataviews/1.json",
            ],
        );
    });

    test("the tiles of one view arriving together are asked about once", async () => {
        const caller = newCaller("allow-slow");

        const responses = await Promise.all(
            Array.from({ length: 8 }, () =>
                throughSidecar(
                    `${unusedEmptyTile()}?form_id=1&temp_token=${caller}`,
                ),
            ),
        );

        assert.deepEqual(
            responses.map(({ status }) => status),
            Array.from({ length: 8 }, () => 204),
        );
        assert.equal((await askedBySidecar()).length, 1);
    });

    const carried = [
        ["a cookie", { cookie: "sessionid=signed-in" }],
        ["an authorization header of its own", { authorization: "Basic abc" }],
        ["a forwarded address", { "x-forwarded-for": "10.0.0.1" }],
        ["an accepted encoding", { "accept-encoding": "gzip" }],
        ["a name of its own", { "x-caller": "somebody" }],
    ];

    // Whatever else nginx adds of its own, nothing of the caller's may be
    // among them.
    const SET_BY_THE_SIDECAR = ["authorization", "connection", "host"];

    for (const [label, headers] of carried) {
        test(`${label} does not reach the service that grants permission`, async () => {
            const caller = newCaller();

            await throughSidecar(
                `${unusedEmptyTile()}?form_id=1&temp_token=${caller}`,
                { headers },
            );

            const [asked] = await askedBySidecar();
            assert.deepEqual(
                Object.keys(asked.headers).filter(
                    (name) => !SET_BY_THE_SIDECAR.includes(name),
                ),
                [],
            );
            assert.equal(asked.authorization, `TempToken ${caller}`);
        });
    }

    // A dataset of its own, so that no answer remembered for another
    // caller can decide this one.
    test("a caller carrying only a cookie is refused", async () => {
        const response = await throughSidecar(`${WORLD}?form_id=97`, {
            headers: { cookie: "sessionid=signed-in" },
        });

        assert.equal(response.status, 403);
    });

    test("a cookie approved upstream does not let the next caller in", async () => {
        const tile = unusedEmptyTile();
        await throughSidecar(`${tile}?form_id=98`, {
            headers: { cookie: "sessionid=signed-in" },
        });

        const next = await throughSidecar(`${tile}?form_id=98`);

        assert.equal(next.status, 403);
    });

    test("an approval is remembered however the upstream says to cache it", async () => {
        const caller = newCaller("allow-nostore");

        await throughSidecar(`${unusedEmptyTile()}?form_id=1&temp_token=${caller}`);
        await throughSidecar(`${unusedEmptyTile()}?form_id=1&temp_token=${caller}`);

        assert.equal((await askedBySidecar()).length, 1);
    });

    test("a preflight is answered without asking", async () => {
        const response = await throughSidecar(`${WORLD}?form_id=1`, {
            method: "OPTIONS",
            headers: {
                origin: "https://first.example.test",
                "access-control-request-method": "GET",
            },
        });

        assert.equal(response.status, 204);
        assert.equal(
            response.headers["access-control-allow-origin"],
            "https://first.example.test",
        );
        assert.deepEqual(await permissionRequests(), []);
    });
});
