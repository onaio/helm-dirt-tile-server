CREATE EXTENSION IF NOT EXISTS postgis;

DROP TABLE IF EXISTS
    logger_instance, logger_dataview, logger_mergedxform_xforms, logger_xform;

CREATE TABLE logger_instance (
    id integer PRIMARY KEY,
    xform_id integer NOT NULL,
    json jsonb NOT NULL DEFAULT '{}',
    geom geometry(GeometryCollection, 4326),
    deleted_at timestamptz
);
CREATE TABLE logger_dataview (
    id integer PRIMARY KEY,
    xform_id integer NOT NULL,
    query jsonb NOT NULL DEFAULT '[]',
    deleted_at timestamptz
);
CREATE TABLE logger_mergedxform_xforms (
    id serial PRIMARY KEY,
    mergedxform_id integer NOT NULL,
    xform_id integer NOT NULL
);
CREATE TABLE logger_xform (
    id integer PRIMARY KEY,
    json jsonb NOT NULL DEFAULT '{}'
);

-- A tile server that compares a filter by the type of its field reads the
-- type from here.
INSERT INTO logger_xform (id, json) VALUES
    (1, '{"name": "data", "type": "survey", "children": [
        {"name": "status", "type": "text"}, {"name": "name", "type": "text"}]}'),
    (2, '{"name": "data", "type": "survey", "children": [
        {"name": "status", "type": "text"}, {"name": "name", "type": "text"}]}'),
    (4, '{"name": "data", "type": "survey", "children": [
        {"name": "name", "type": "text"}, {"name": "notes", "type": "text"}]}');

INSERT INTO logger_instance (id, xform_id, json, geom) VALUES
    (101, 1, '{"status": "approved", "name": "nairobi"}',
        ST_ForceCollection(ST_SetSRID(ST_MakePoint(36.8, -1.3), 4326))),
    (102, 1, '{"status": "pending", "name": "thika"}',
        ST_ForceCollection(ST_SetSRID(ST_MakePoint(36.9, -1.2), 4326))),
    (201, 2, '{"status": "approved", "name": "kampala"}',
        ST_ForceCollection(ST_SetSRID(ST_MakePoint(32.5, 0.3), 4326)));
-- Enough submissions for a tile that the tile server compresses.
INSERT INTO logger_instance (id, xform_id, json, geom)
SELECT
    4000 + n,
    4,
    jsonb_build_object('name', 'submission ' || n, 'notes', md5(n::text)),
    ST_ForceCollection(ST_SetSRID(ST_MakePoint(30 + n * 0.01, n * 0.01), 4326))
FROM generate_series(1, 300) AS n;

-- Two datasets of each kind, which differ in every tile that holds form 1.
INSERT INTO logger_dataview (id, xform_id, query) VALUES
    (10, 1, '[{"column": "status", "filter": "=", "value": "approved"}]'),
    (11, 1, '[{"column": "status", "filter": "=", "value": "pending"}]');
INSERT INTO logger_mergedxform_xforms (mergedxform_id, xform_id) VALUES
    (50, 1), (50, 2),
    (51, 2);
