const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
    ALLOWED_ORIGIN,
    OTHER_ALLOWED_ORIGIN,
    throughSidecar,
    fromTileServer,
    compressed,
    contentOf,
    proxyLog,
    newCaller,
    unusedEmptyTile,
} = require("./helpers");

// Each test asks for a tile of its own, so that what one test left in the
// cache cannot decide another's outcome.
const REGION = "/v1/mvt/5/19/16";
const CITY = "/v1/mvt/8/154/128";
const DISTRICT = "/v1/mvt/9/308/257";
const SUBURB = "/v1/mvt/10/616/515";
const SHARED = "/v1/mvt/7/77/64";
const GUARDED = "/v1/mvt/6/38/32";
const FILTERED = "/v1/mvt/4/9/8";
const REFRESHED = "/v1/mvt/3/4/4";
const ENCODED = "/v1/mvt/2/2/2";
const ORIGINS = "/v1/mvt/1/1/1";

// All within the area that holds form 1, where the datasets of a pair differ.
const PAIRS = {
    forms: "/v1/mvt/11/1233/1031",
    dataviews: "/v1/mvt/12/2466/2062",
    "merged datasets": "/v1/mvt/13/4933/4125",
    "a form and a dataview of the same number": "/v1/mvt/14/9866/8251",
    "a dataview and a merged dataset of the same number": "/v1/mvt/15/19733/16502",
};

const twice = async (path) => [
    await throughSidecar(path),
    await throughSidecar(path),
];

describe("cached responses", () => {
    test("a tile is fetched once and then served from the cache", async () => {
        const path = `${REGION}?form_id=1&temp_token=${newCaller()}`;

        const [first, second] = await twice(path);

        assert.deepEqual([first.status, second.status], [200, 200]);
        assert.deepEqual([first.cache, second.cache], ["MISS", "HIT"]);
        assert.deepEqual(second.body, first.body);
    });

    test("a cached tile is the tile the tile server gives", async () => {
        const path = `${CITY}?form_id=1&temp_token=${newCaller()}`;

        const [, cached] = await twice(path);
        const direct = await fromTileServer(path);

        assert.equal(cached.cache, "HIT");
        assert.equal(cached.headers["content-type"], "application/x-protobuf");
        assert.ok(direct.body.length > 0);
        assert.deepEqual(contentOf(cached), contentOf(direct));
    });

    test("bounds are cached like tiles", async () => {
        const path = `/v1/bounds?form_id=1&temp_token=${newCaller()}`;

        const [first, second] = await twice(path);

        assert.deepEqual([first.cache, second.cache], ["MISS", "HIT"]);
        assert.deepEqual(JSON.parse(second.body), {
            xmin: 36.8,
            ymin: -1.3,
            xmax: 36.9,
            ymax: -1.2,
        });
    });

    test("an empty tile is cached too", async () => {
        const path = `${unusedEmptyTile()}?form_id=1&temp_token=${newCaller()}`;

        const [first, second] = await twice(path);

        assert.deepEqual([first.status, second.status], [204, 204]);
        assert.deepEqual([first.cache, second.cache], ["MISS", "HIT"]);
    });

    test("callers allowed to read a dataset share its cached tiles", async () => {
        const first = await throughSidecar(
            `${SHARED}?form_id=1&temp_token=${newCaller()}`,
        );
        const second = await throughSidecar(
            `${SHARED}?form_id=1&temp_token=${newCaller()}`,
        );

        assert.deepEqual([first.cache, second.cache], ["MISS", "HIT"]);
    });

    test("a cached tile is refused to a caller who may not read it", async () => {
        const stored = await twice(
            `${GUARDED}?form_id=1&temp_token=${newCaller()}`,
        );
        assert.equal(stored[1].cache, "HIT");

        const refused = await throughSidecar(
            `${GUARDED}?form_id=1&temp_token=${newCaller("deny-403")}`,
        );
        const anonymous = await throughSidecar(`${GUARDED}?form_id=1`);

        assert.ok(
            contentOf(stored[1]).includes("nairobi"),
            "the cached tile does not name what the refused ones must not",
        );
        assert.deepEqual([refused.status, anonymous.status], [403, 403]);
        assert.deepEqual(
            [
                contentOf(refused).includes("nairobi"),
                contentOf(anonymous).includes("nairobi"),
            ],
            [false, false],
        );
    });

    const pairs = [
        ["forms", "form_id=1", "form_id=2"],
        ["dataviews", "dataview_id=10", "dataview_id=11"],
        ["merged datasets", "merged_dataset_id=50", "merged_dataset_id=51"],
        ["a form and a dataview of the same number", "form_id=10", "dataview_id=10"],
        ["a dataview and a merged dataset of the same number", "dataview_id=50", "merged_dataset_id=50"],
    ];

    for (const [label, one, other] of pairs) {
        test(`two ${label} are cached apart`, async () => {
            const caller = newCaller();
            const tile = PAIRS[label];
            const stored = await twice(`${tile}?${one}&temp_token=${caller}`);

            const path = `${tile}?${other}&temp_token=${caller}`;
            const fetched = await throughSidecar(path);
            const direct = await fromTileServer(path);

            assert.equal(stored[1].cache, "HIT");
            assert.equal(fetched.cache, "MISS");
            assert.equal(fetched.status, direct.status);
            assert.deepEqual(contentOf(fetched), contentOf(direct));
            assert.notDeepEqual(
                [stored[1].status, contentOf(stored[1])],
                [fetched.status, contentOf(fetched)],
            );
        });
    }

    const variants = [
        ["another dataset", "form_id=2"],
        ["a dataview of the dataset", "dataview_id=10"],
        ["a merged dataset holding it", "merged_dataset_id=50"],
        ["a field filter", "form_id=1&field_name=status&field_value=approved"],
        ["another field value", "form_id=1&field_name=status&field_value=pending"],
        ["another field name", "form_id=1&field_name=name&field_value=approved"],
        ["an id column", "form_id=1&id_column=id"],
        ["extra columns", "form_id=1&columns=id"],
        ["a field name that holds the separator", "form_id=1&field_name=status|x&field_value=approved"],
        ["a field value that holds the separator", "form_id=1&field_name=status&field_value=x|approved"],
        ["an empty field value", "form_id=1&field_name=status&field_value="],
        ["a row limit", "form_id=1&limit=1"],
    ];

    for (const [label, args] of variants) {
        test(`${label} is cached apart from the plain tile`, async () => {
            const caller = newCaller();
            await twice(`${FILTERED}?form_id=1&temp_token=${caller}`);

            const path = `${FILTERED}?${args}&temp_token=${caller}`;
            const [first, second] = await twice(path);
            const direct = await fromTileServer(path);

            assert.deepEqual([first.cache, second.cache], ["MISS", "HIT"]);
            assert.equal(second.status, direct.status);
            assert.deepEqual(contentOf(second), contentOf(direct));
        });
    }

    test("the plain tile is still the plain tile after its variants were asked for", async () => {
        const path = `${FILTERED}?form_id=1&temp_token=${newCaller()}`;

        const cached = await throughSidecar(path);
        const direct = await fromTileServer(path);
        const filtered = await fromTileServer(
            `${FILTERED}?form_id=1&field_name=status&field_value=approved&temp_token=${newCaller()}`,
        );

        assert.equal(cached.cache, "HIT");
        assert.deepEqual(contentOf(cached), contentOf(direct));
        assert.notDeepEqual(contentOf(direct), contentOf(filtered));
    });

    test("a filter smuggled under an encoded name never reaches the cache", async () => {
        const caller = newCaller();

        const smuggled = await throughSidecar(
            `${ENCODED}?form_id=1&field%5Fname=status&field%5Fvalue=approved&temp_token=${caller}`,
        );
        const plain = await throughSidecar(
            `${ENCODED}?form_id=1&temp_token=${caller}`,
        );
        const direct = await fromTileServer(
            `${ENCODED}?form_id=1&temp_token=${caller}`,
        );

        assert.equal(smuggled.status, 400);
        assert.equal(plain.cache, "MISS");
        assert.deepEqual(contentOf(plain), contentOf(direct));
    });

    test("a request the tile server refuses is not cached", async () => {
        const path = `${DISTRICT}?form_id=1&columns=xml&temp_token=${newCaller()}`;

        const [first, second] = await twice(path);

        assert.deepEqual([first.status, second.status], [400, 400]);
        assert.notEqual(second.cache, "HIT");
    });

    test("nocache fetches afresh and replaces what is cached", async () => {
        const caller = newCaller();
        const path = `${REFRESHED}?form_id=1&temp_token=${caller}`;
        const [, stored] = await twice(path);

        const refreshed = await throughSidecar(`${path}&nocache=1`);
        const after = await throughSidecar(path);

        assert.equal(stored.cache, "HIT");
        assert.equal(refreshed.cache, "BYPASS");
        assert.equal(refreshed.status, 200);
        assert.equal(after.cache, "HIT");
        assert.deepEqual(contentOf(after), contentOf(refreshed));
        assert.ok(contentOf(after).length > 0, "the tile came back empty");
    });

    test("the tile server compresses a tile of this size", async () => {
        const direct = await fromTileServer(
            `/v1/mvt/0/0/0?form_id=4&temp_token=${newCaller()}`,
            compressed,
        );

        assert.equal(direct.headers["content-encoding"], "gzip");
    });

    test("one cached tile serves callers that take compression and callers that do not", async () => {
        const path = `/v1/mvt/0/0/0?form_id=4&temp_token=${newCaller()}`;

        const packed = await throughSidecar(path, compressed);
        const plain = await throughSidecar(path);

        assert.equal(packed.headers["content-encoding"], "gzip");
        assert.equal(plain.headers["content-encoding"], undefined);
        assert.deepEqual([packed.cache, plain.cache], ["MISS", "HIT"]);
        assert.deepEqual(contentOf(packed), contentOf(plain));
        assert.ok(plain.body.length > packed.body.length);
    });

    test("a tile cached for a caller that takes no compression still reaches one that does", async () => {
        const path = `/v1/mvt/1/1/0?form_id=4&temp_token=${newCaller()}`;

        const plain = await throughSidecar(path);
        const packed = await throughSidecar(path, compressed);

        assert.deepEqual([plain.cache, packed.cache], ["MISS", "HIT"]);
        assert.equal(packed.headers["content-encoding"], "gzip");
        assert.deepEqual(contentOf(packed), contentOf(plain));
    });

    test("a small tile, which the tile server leaves uncompressed, is served as it is", async () => {
        const path = `${SUBURB}?form_id=1&temp_token=${newCaller()}`;

        const [first, second] = await twice(path);
        const direct = await fromTileServer(path);

        assert.equal(second.cache, "HIT");
        assert.equal(second.headers["content-encoding"], undefined);
        assert.deepEqual(second.body, direct.body);
        assert.deepEqual(first.body, direct.body);
    });
});

describe("cross-origin headers", () => {
    const from = (origin) => ({ headers: { origin } });

    const allowedFor = async (path, origin) =>
        (await throughSidecar(path, from(origin))).headers[
            "access-control-allow-origin"
        ];

    test("each allowed origin is named in its own response, cached or not", async () => {
        const path = `${ORIGINS}?form_id=1&temp_token=${newCaller()}`;

        assert.equal(await allowedFor(path, ALLOWED_ORIGIN), ALLOWED_ORIGIN);
        assert.equal(
            await allowedFor(path, OTHER_ALLOWED_ORIGIN),
            OTHER_ALLOWED_ORIGIN,
        );
        assert.equal(await allowedFor(path, ALLOWED_ORIGIN), ALLOWED_ORIGIN);
    });

    test("an origin that is not allowed is not named, cached or not", async () => {
        const path = `${ORIGINS}?form_id=1&temp_token=${newCaller()}`;
        await throughSidecar(path, from(ALLOWED_ORIGIN));

        assert.equal(
            await allowedFor(path, "https://elsewhere.example.test"),
            undefined,
        );
    });

    test("a response names one origin only", async () => {
        const path = `${ORIGINS}?form_id=1&temp_token=${newCaller()}`;

        const response = await throughSidecar(path, from(ALLOWED_ORIGIN));

        assert.equal(
            response.headers["access-control-allow-origin"],
            ALLOWED_ORIGIN,
        );
        assert.equal(response.headers.vary, "Origin, Accept-Encoding");
    });
});

describe("the sidecar's log", () => {
    // A tile of its own, so that the line found is this request's.
    test("records a request without the caller's token", async () => {
        const caller = newCaller();
        const tile = unusedEmptyTile();

        await throughSidecar(`${tile}?form_id=1&temp_token=${caller}`);
        const log = proxyLog();

        assert.match(log, new RegExp(`"GET ${tile}" 204 .*form=1`));
        assert.equal(log.includes(caller), false);
    });
});
