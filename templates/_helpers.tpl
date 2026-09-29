{{/*
Expand the name of the chart.
*/}}
{{- define "dirt-tile-server.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "dirt-tile-server.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "dirt-tile-server.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "dirt-tile-server.labels" -}}
helm.sh/chart: {{ include "dirt-tile-server.chart" . }}
{{ include "dirt-tile-server.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "dirt-tile-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dirt-tile-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "dirt-tile-server.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "dirt-tile-server.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
The origins allowed to read responses, as a JSON list, from the same setting
the application reads.
*/}}
{{- define "dirt-tile-server.allowedOrigins" -}}
{{- $origins := list }}
{{- range splitList "," (.Values.configs.corsorigins | default "" | toString) }}
{{- $origin := trim . }}
{{- if $origin }}
{{- $origins = append $origins $origin }}
{{- end }}
{{- end }}
{{- $origins | toJson }}
{{- end }}

{{/*
nginx repeats none of the headers of an outer block in a block that adds one
of its own, so every block that adds a header includes these.
*/}}
{{- define "dirt-tile-server.corsHeaders" -}}
add_header Access-Control-Allow-Origin  $cors_origin always;
add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
add_header Access-Control-Max-Age       "3600" always;
add_header Vary                         "Origin, Accept-Encoding" always;
{{- end }}

{{/*
For a location that passes a request on: the tile server's own headers are
dropped, or the caller would be given each of them twice.
*/}}
{{- define "dirt-tile-server.corsHeadersOfOurOwn" -}}
proxy_hide_header Access-Control-Allow-Origin;
proxy_hide_header Access-Control-Allow-Methods;
proxy_hide_header Access-Control-Allow-Headers;
proxy_hide_header Access-Control-Max-Age;
proxy_hide_header Access-Control-Expose-Headers;
proxy_hide_header Vary;
{{ include "dirt-tile-server.corsHeaders" . }}
{{- end }}

{{/*
The body of a location whose responses are checked for permission and cached.
*/}}
{{- define "dirt-tile-server.cachedLocation" -}}
if ($accepted_args = 0) {
  return 400 '{"error":"Unrecognised or repeated parameter."}';
}
if ($permission_url = "") {
  return 400 '{"error":"Exactly one of form_id, dataview_id or merged_dataset_id is required."}';
}
set $permission_target $permission_url;
set $permission_host   "{{ .Values.sidecar.onadataHost | default (regexReplaceAll "^https?://" (.Values.sidecar.onadataUrl | default .Values.configs.onadataurl) "") }}";
set $permission_header_sent $permission_header;
auth_request /_permission;
{{- if .Values.sidecar.responseCache.enabled }}
proxy_cache response_cache;
# Names every parameter that changes the response, and leaves out the token:
# two callers allowed to read a dataset share its cached responses.
proxy_cache_key "$uri|$arg_form_id|$arg_dataview_id|$arg_merged_dataset_id|$arg_field_name|$arg_field_value|$arg_columns|$arg_id_column";
proxy_cache_valid 200 204 {{ .Values.sidecar.responseCache.ttlSeconds }}s;
# The upstream marks its responses private and varying, for the browser.
proxy_ignore_headers Cache-Control Expires Set-Cookie Vary;
proxy_cache_bypass $arg_nocache;
proxy_cache_lock on;
proxy_cache_use_stale updating error timeout;
proxy_cache_background_update on;
{{- end }}
# Stored compressed, once, and decompressed for a caller that cannot take it.
proxy_set_header Accept-Encoding gzip;
proxy_set_header Connection "";
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
gunzip on;
proxy_read_timeout {{ .Values.sidecar.readTimeoutSeconds }}s;
{{ include "dirt-tile-server.corsHeadersOfOurOwn" . }}
{{- if .Values.sidecar.responseCache.enabled }}
add_header X-Cache-Status $upstream_cache_status always;
{{- end }}
proxy_pass http://tiles;
{{- end }}
