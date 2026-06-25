# Civians API — Integration Guide for Rork

## Base URL
```
https://civians.astrolle.com
```

## Authentication
Every request (except POST /profile and GET /health) requires the header:
```
X-Api-Key: <device_id>
```
The `device_id` is set by the mobile app (use the device's unique identifier). It is registered once and acts as the API key forever.

---

## 1. Profile

### Register device (no auth required)
```
POST /profile
Content-Type: application/json

{
  "device_id": "string",       // unique device identifier — this becomes the API key
  "name": "string",            // user's full name
  "phone": "string",           // e.g. "+573001234567"
  "city": "string",            // optional
  "country": "string"          // optional
}
```
Response `201`:
```json
{ "api_key": "device_id", "profile": { "device_id", "name", "phone", "city", "country", "registered_at" } }
```

### Get my profile
```
GET /profile/me
X-Api-Key: <device_id>
```

### Update profile
```
PUT /profile/me
X-Api-Key: <device_id>
Content-Type: application/json

{
  "name": "string",   // optional
  "phone": "string"   // optional
}
```

### Update GPS location (call every time the user moves or changes city)
```
PATCH /profile/me/location
X-Api-Key: <device_id>
Content-Type: application/json

{
  "latitude": number,
  "longitude": number
}
```

---

## 2. Media Upload

Upload photos or videos before creating a notification or report. Returns CDN URLs to use in the `media` or `photos` fields.

```
POST /media/upload
X-Api-Key: <device_id>
Content-Type: multipart/form-data

files: File[]     // 1–3 files, field name must be "files"
folder: string    // "notifications" or "reports"
```
Response `201`:
```json
{ "urls": ["https://civians.b-cdn.net/civians/reports/device-timestamp.jpg"] }
```
Allowed types: `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `video/mp4`, `video/quicktime`, `video/webm`. Max 50MB per file.

---

## 3. Official Notifications (TTL 7 days)

Created by authorities. Triggers push notification to all users within 5km.

### Create
```
POST /notifications/official
X-Api-Key: <device_id>
Content-Type: application/json

{
  "title": "string",                          // required
  "description": "string",                    // required
  "event_type": "string",                     // e.g. "sismo", "inundacion", "incendio"
  "severity": "info" | "warning" | "critical", // required
  "location": {
    "coordinates": [longitude, latitude],     // required — [lng, lat] order
    "name": "string",                         // required
    "neighborhood": "string",                 // optional
    "city": "string"                          // optional
  },
  "position": "string",                       // optional — affected zone description
  "characteristics": { "key": "value" },      // optional — e.g. { "magnitude": 5.2 }
  "issued_by": "string",                      // optional — issuing authority
  "media": ["url1", "url2"]                   // optional — CDN URLs from /media/upload
}
```

### List official notifications
```
GET /notifications/official
X-Api-Key: <device_id>

Query params (all optional):
  limit=20
  offset=0
  event_type=sismo
  severity=critical
```
Each notification includes:
- `confirmations`: number of users who confirmed it
- `confirmed_by_me`: boolean — whether the current user confirmed it
- `created_by`: device_id of the creator (use to show edit/delete buttons)

---

## 4. Unofficial Notifications (TTL 3 days)

Created by any user. Triggers push notification to all users within 5km.

### Create
```
POST /notifications/unofficial
X-Api-Key: <device_id>
Content-Type: application/json

{
  "title": "string",                           // required
  "description": "string",                     // required
  "event_type": "string",                      // required
  "severity": "info" | "warning" | "critical", // required
  "location": {
    "coordinates": [longitude, latitude],      // required
    "name": "string",                          // required
    "neighborhood": "string",                  // optional
    "city": "string"                           // optional
  },
  "media": ["url1", "url2"]                    // optional — CDN URLs from /media/upload
}
```

### List unofficial notifications
```
GET /notifications/unofficial
X-Api-Key: <device_id>

Query params: limit, offset, event_type, severity
```

---

## 5. Notifications — Shared Actions

### Get single notification
```
GET /notifications/:id
X-Api-Key: <device_id>
```

### Edit notification (owner only — check created_by === device_id)
```
PATCH /notifications/:id
X-Api-Key: <device_id>
Content-Type: application/json

{ any updatable fields }
```
Returns `403` if not the owner.

### Delete notification (owner only)
```
DELETE /notifications/:id
X-Api-Key: <device_id>
```
Returns `403` if not the owner.

### Confirm notification (raises its ranking)
```
POST /notifications/:id/confirm
X-Api-Key: <device_id>
```
Returns `409` if already confirmed.

### Remove confirmation
```
DELETE /notifications/:id/confirm
X-Api-Key: <device_id>
```

---

## 6. Reports (TTL 24 hours)

User-submitted situational reports. Urgent types (`estoy_en_peligro`, `necesito_ayuda`, `busco_a_alguien`) trigger push notifications to nearby users.

### Create report
```
POST /reports
X-Api-Key: <device_id>
Content-Type: application/json

{
  "type": "estoy_en_peligro" | "busco_a_alguien" | "necesito_ayuda" | "ofrezco_refugio" | "informo_algo" | "estoy_a_salvo",
  "message": "string",           // optional — description
  "location": {
    "coordinates": [longitude, latitude],  // required
    "neighborhood": "string",              // optional
    "city": "string"                       // optional
  },
  "contact_phone": "string",     // optional
  "photos": ["url1", "url2"],    // optional — up to 3 CDN URLs from /media/upload

  // Only for type "busco_a_alguien":
  "target_name": "string",       // optional — name/description of missing person

  // Only for type "ofrezco_refugio":
  "amenities": {
    "agua_potable": boolean,
    "comida": boolean,
    "espacio_para_dormir": boolean,
    "ropa_y_abrigo": boolean,
    "electricidad": boolean,
    "carga_de_celular": boolean,
    "wifi_senal": boolean,
    "bano_y_ducha": boolean,
    "botiquin_y_medicinas": boolean,
    "acepta_mascotas": boolean,
    "apto_para_ninos": boolean,
    "acceso_silla_ruedas": boolean,
    "capacity": number,            // optional — max people
    "notes": "string"              // optional
  }
}
```

### List reports — always send user's current coordinates
```
GET /reports?latitude=6.2442&longitude=-75.5812
X-Api-Key: <device_id>

Query params:
  latitude=<number>   // REQUIRED — current user latitude
  longitude=<number>  // REQUIRED — current user longitude
  type=ofrezco_refugio  // optional — filter by report type
```
⚠️ `latitude` and `longitude` are REQUIRED. The API only returns reports within 5km of the given position. Always pass the user's current GPS coordinates. Without them the request returns 400.

### My reports
```
GET /reports/me
X-Api-Key: <device_id>
```

### Get single report
```
GET /reports/:id
X-Api-Key: <device_id>
```

### Deactivate report (owner only)
```
DELETE /reports/:id
X-Api-Key: <device_id>
```

---

## 7. Health Check (no auth)
```
GET /health
```
Response: `{ "status": "ok", "service": "civians-api", "ts": "ISO timestamp" }`

---

## Error Responses

| Code | Meaning |
|------|---------|
| `400` | Validation error — check `error` field for details |
| `401` | Missing or invalid `X-Api-Key` |
| `403` | Action not allowed — not the owner |
| `404` | Resource not found or expired (TTL reached) |
| `409` | Conflict — e.g. already confirmed this notification |
| `500` | Server error |

---

## Location Rules — CRITICAL

The app must always track the user's current GPS position and pass it on every relevant request.

**On every app launch and every time the user moves:**
```
PATCH /profile/me/location
{ "latitude": <current>, "longitude": <current> }
```

**On every call to GET /reports — always pass current coordinates:**
```
GET /reports?latitude=<current>&longitude=<current>
```
Never call `GET /reports` without latitude and longitude. The API returns 400 if they are missing. The response only includes reports within 5km of the given position.

**When creating a report — location.coordinates is required:**
```json
"location": {
  "coordinates": [longitude, latitude],
  "city": "..."
}
```

**When the user selects a city manually** (instead of using GPS), use the city center coordinates as the latitude/longitude values for all requests.

---

## Key Rules for the UI

- **Always call `PATCH /profile/me/location`** when the app gets a GPS update.
- **Upload media first** via `POST /media/upload`, then pass the returned URLs into `media[]` or `photos[]` when creating a notification or report.
- **`coordinates` format is always `[longitude, latitude]`** — longitude first, latitude second.
- **Show edit/delete controls only when** `notification.created_by === currentDeviceId` or `report.device_id === currentDeviceId`.
- **Confirm button state**: use `confirmed_by_me` boolean from the notification object to toggle the button UI.
- Notifications and reports **expire automatically** (7d / 3d / 24h). A `404` on a previously valid ID means it expired.
