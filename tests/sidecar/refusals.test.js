const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
    ALLOWED_ORIGIN,
    throughSidecar,
    permissionRequests,
    forgetPermissionRequests,
    newCaller,
} = require("./helpers");

const WORLD = "/v1/mvt/0/0/0";

describe("requests the sidecar answers itself", () => {
    beforeEach(forgetPermissionRequests);

    test("the health check needs no dataset and no permission", async () => {
        const response = await throughSidecar("/health-check");

        assert.equal(response.status, 200);
        assert.equal(response.body.toString(), "healthy");
        assert.deepEqual(await permissionRequests(), []);
    });

    test("the health check names an allowed origin once", async () => {
        const response = await throughSidecar("/health-check", {
            headers: { origin: ALLOWED_ORIGIN },
        });

        assert.equal(response.status, 200);
        assert.equal(
            response.headers["access-control-allow-origin"],
            ALLOWED_ORIGIN,
        );
    });

    for (const path of [
        "/",
        "/v1/query/logger_instance",
        "/v1/mvt",
        "/v1/mvt/0/0",
        "/v1/mvt/0/0/0/",
        "/v1/mvt/0/0/0/0",
        "/v1/mvt/00/0/0",
        "/v1/mvt/0/01/0",
        "/v1/mvt/a/0/0",
        "/v1/mvt/0/0/-1",
        "/v1/mvt/100/0/0",
        "/V1/MVT/0/0/0",
        "/v1/bounds/",
        "/v1/bounds/extra",
    ]) {
        test(`${path} is not served`, async () => {
            const response = await throughSidecar(
                `${path}?form_id=1&temp_token=${newCaller()}`,
            );

            assert.equal(response.status, 404);
            assert.deepEqual(await permissionRequests(), []);
        });
    }

    test("the permission request cannot be made from outside", async () => {
        const response = await throughSidecar(
            `/_permission?form_id=1&temp_token=${newCaller()}`,
        );

        assert.equal(response.status, 403);
        assert.deepEqual(await permissionRequests(), []);
    });

    const withoutOneDataset = [
        ["no dataset id", ""],
        ["two dataset ids", "form_id=1&dataview_id=10"],
        ["three dataset ids", "form_id=1&dataview_id=10&merged_dataset_id=50"],
        ["an id of zero", "form_id=0"],
        ["an id with a leading zero", "form_id=01"],
        ["a negative id", "form_id=-1"],
        ["a decimal id", "form_id=1.5"],
        ["an id with letters", "form_id=1a"],
        ["an id that is a path", "form_id=../../users"],
        ["an id that is an encoded path", "form_id=..%2F..%2Fusers"],
        ["an id with a query of its own", "form_id=1%3Fformat%3Dxls"],
        ["an id longer than ten digits", "form_id=12345678901"],
        ["an empty id", "form_id="],
    ];

    for (const path of [WORLD, "/v1/bounds"]) {
        for (const [label, dataset] of withoutOneDataset) {
            test(`${path} with ${label} is a 400 and asks nothing`, async () => {
                const token = `temp_token=${newCaller()}`;
                const args = [dataset, token].filter(Boolean).join("&");

                const response = await throughSidecar(`${path}?${args}`);

                assert.equal(response.status, 400);
                assert.deepEqual(Object.keys(JSON.parse(response.body)), [
                    "error",
                ]);
                assert.deepEqual(await permissionRequests(), []);
            });
        }
    }

    const unrecognised = [
        ["a parameter the tile server does not read", "form_id=1&table=users"],
        ["an encoded dataset parameter name", "form%5Fid=1"],
        ["an encoded name beside a plain one", "form_id=1&form%5Fid=2"],
        ["an encoded filter name", "form_id=1&field%5Fname=status&field_value=approved"],
        ["an encoded token name", "form_id=1&temp%5Ftoken=abc"],
        ["a name in another case", "form_id=1&FIELD_NAME=status"],
        ["a name with brackets", "form_id=1&columns[]=id"],
        ["a parameter without a value sign", "form_id=1&nocache"],
        ["an empty parameter", "form_id=1&&columns=id"],
        ["a trailing separator", "form_id=1&"],
        ["a semicolon separator", "form_id=1;field_name=status"],
    ];

    for (const [label, args] of unrecognised) {
        test(`${label} is a 400 and asks nothing`, async () => {
            const response = await throughSidecar(`${WORLD}?${args}`);

            assert.equal(response.status, 400);
            assert.deepEqual(await permissionRequests(), []);
        });
    }

    const givenTwice = [
        ["a dataset id", "form_id=1&form_id=2"],
        ["a dataset id, apart", "form_id=1&columns=id&form_id=2"],
        ["a field name", "form_id=1&field_name=status&field_name=age&field_value=approved"],
        ["a field value", "form_id=1&field_name=status&field_value=approved&field_value=rejected"],
        ["columns", "form_id=1&columns=id&columns=json"],
        ["an id column", "form_id=1&id_column=id&id_column=json"],
        ["a token", "form_id=1&temp_token=first&temp_token=second"],
        ["nocache", "form_id=1&nocache=1&nocache=2"],
    ];

    for (const [label, args] of givenTwice) {
        test(`${label} given twice is a 400 and asks nothing`, async () => {
            const response = await throughSidecar(`${WORLD}?${args}`);

            assert.equal(response.status, 400);
            assert.deepEqual(await permissionRequests(), []);
        });
    }

    const givenOnce = [
        ["a value that is another parameter's name", "field_name=form_id&field_value=1"],
        ["a value that holds a name and a value sign", "field_name=status&field_value=form_id=1"],
        ["names that end alike", "columns=id&id_column=id"],
    ];

    for (const [label, args] of givenOnce) {
        test(`${label} is not taken for a parameter given twice`, async () => {
            const response = await throughSidecar(
                `${WORLD}?form_id=1&${args}&temp_token=${newCaller()}`,
            );

            assert.notEqual(response.status, 400);
            assert.notDeepEqual(await permissionRequests(), []);
        });
    }

    test("a refusal can be read by an allowed origin", async () => {
        const response = await throughSidecar(`${WORLD}?form_id=0`, {
            headers: { origin: "https://first.example.test" },
        });

        assert.equal(response.status, 400);
        assert.equal(
            response.headers["access-control-allow-origin"],
            "https://first.example.test",
        );
    });
});
