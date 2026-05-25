# Skill Market API

CCUI exposes `/api/skill-market/...` to the frontend. The CCUI backend then calls the remote Skill Market service configured by:

```text
SKILL_MARKET_BASE_URL=https://xxxxxx
```

`SKILL_MARKET_BASE_URL` should contain only the scheme, host, and optional port. CCUI appends the remote Skill endpoints under `/data-agent/api/skill/...`. `http://` and `https://` are both supported.

`SKILL_MARKET_API_URL` is still accepted as a compatibility fallback. Local mock development can use:

```text
SKILL_MARKET_BASE_URL=http://127.0.0.1:3101
```

Optional remote authorization:

```text
SKILL_MARKET_AUTH_APPID=
SKILL_MARKET_AUTH_KEY=
```

When both values are blank, CCUI sends no authorization header. When configured, every remote Skill Market request includes:

```text
Authorization: CLOUDSOA-HMAC-SHA256 appid={SKILL_MARKET_AUTH_APPID}, timestamp={timestamp}, signature="{signature}"
```

Every remote Skill Market request also includes the current tenant code from the CCUI `tenants` table:

```text
X-Data-Agent-Tenant: {tenants.code}
```

Every remote Skill Market request includes the current account username from the CCUI `users` table:

```text
X-Account-Id: {users.username}
```

The signature is:

```text
payload = JSON.stringify(requestBody)
builder = method.toUpperCase() + '&' + requestPath + '&&' + payload + '&appid=' + appid + '&timestamp=' + timestamp
signature = Base64(HMAC-SHA256(builder, Hex.parse(authKey)))
```

For the multipart `update` endpoint, the signature payload is empty. Its builder ends with:

```text
POST&/data-agent/api/skill/update&&&appid={appid}&timestamp={timestamp}
```

## Remote Service

### `POST /data-agent/api/skill/skillList`

Request:

```json
{
  "data": {
    "searchContent": ""
  },
  "pageInfo": {
    "page": 1,
    "pageSize": 20
  }
}
```

Response data may be an array, a single object, or a paginated object containing `list`, `records`, `items`, `rows`, or `skills`. CCUI only shows skills with `published: true`.

Skill fields used by CCUI:

```json
{
  "id": "skill id",
  "skillName": "skill folder/name",
  "description": "skill description",
  "nspPath": "cloud storage path",
  "mpdifyTimestamp": "last modified timestamp",
  "createUserId": "creator username",
  "version": 1,
  "published": true
}
```

### `POST /data-agent/api/skill/preview`

Request without `filePath` returns the tree:

```json
{
  "data": {
    "id": "skill id",
    "nspPath": "cloud storage path",
    "queryVersion": 1
  }
}
```

Request with `filePath` also returns file content:

```json
{
  "data": {
    "filePath": "SKILL.md",
    "queryVersion": 1,
    "id": "skill id",
    "nspPath": "cloud storage path"
  }
}
```

Response:

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "directoryTree": [
      {
        "name": "SKILL.md",
        "path": "SKILL.md",
        "isDirectory": false
      }
    ],
    "fileContent": "# Skill content"
  }
}
```

### `POST /data-agent/api/skill/download`

Request:

```json
{
  "data": {
    "id": "skill id",
    "nspPath": "cloud storage path"
  }
}
```

CCUI calls this before importing or updating a local skill. If the response includes file data, CCUI writes it directly. If it returns a zip stream, CCUI extracts it. If neither is present, CCUI falls back to `preview` for each file.

### `POST /data-agent/api/skill/update`

Multipart form data. CCUI sends:

- `file`: zip archive of the complete local skill directory.
- `id`: skill id.

Authorization for this endpoint signs an empty payload, not the multipart form body.

### `POST /data-agent/api/skill/publish`

Request:

```json
{
  "data": {
    "id": "skill id"
  }
}
```

Response:

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "version": 4
  }
}
```

## CCUI Proxy Flow

- The Skill Market dialog lists skills through `skillList`.
- Selecting a skill that has not been imported calls `preview` once for the file tree, then calls `preview` again for the default `SKILL.md` content.
- Selecting or opening files for an imported skill reads the workspace copy under `.claude/skills/{skillName}` instead of calling remote `preview`.
- Clicking a file in the tree calls `preview` with that file path only when the skill is not imported.
- Import calls `download` and writes into `Files/.claude/skills/{skillName}`.
- Imported state is computed from local workspace files plus `.cloudcli/skills/market-imports.json`, not from the remote list response.
- Update availability is computed by comparing remote `version` with the locally imported version.
- Update overwrites the local imported skill with the latest remote content.
- Publishing is only shown when the current CCUI username equals the remote `createUserId`.
- Publishing first shows a full-skill file diff and requires typing `yes`; CCUI then calls `update` followed by `publish`.
