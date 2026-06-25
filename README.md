# Civians API 🚨

Emergency notification API. Built on Node.js + TypeScript + Redis.

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Requires Redis running locally (`redis-server`) or set `REDIS_URL` in `.env`.

---

## Authentication

Every request (except `POST /profile` and `GET /health`) requires:
```
X-Api-Key: <your_device_id>
```
Your `device_id` IS your API key.

---

## Endpoints

### Register Device
```
POST /profile
```
```json
{
  "device_id": "iphone-uuid-abc123",
  "name": "Juan Pérez",
  "phone": "+573001234567"
}
```
Returns `api_key` = your `device_id`.

---

### Get My Profile
```
GET /profile/me
X-Api-Key: iphone-uuid-abc123
```

---

### Update My Profile
```
PUT /profile/me
X-Api-Key: iphone-uuid-abc123

{ "name": "Juan Carlos Pérez" }
```

---

### Create Official Notification
```
POST /notifications
X-Api-Key: iphone-uuid-abc123
```
```json
{
  "title": "Sismo M5.2 - Bogotá",
  "description": "Se registró un sismo de magnitud 5.2 con epicentro en Bogotá",
  "event_type": "sismo",
  "severity": "critical",
  "location": {
    "name": "Bogotá, Colombia",
    "coordinates": [-74.0721, 4.7110]
  },
  "position": "Zona centro-norte",
  "characteristics": {
    "magnitude": 5.2,
    "depth_km": 10,
    "scale": "Richter"
  },
  "issued_by": "SGC Colombia"
}
```

**severity**: `info` | `warning` | `critical`

---

### List Notifications
```
GET /notifications?limit=20&offset=0
GET /notifications?event_type=sismo
GET /notifications?severity=critical
X-Api-Key: iphone-uuid-abc123
```

---

### Get Single Notification
```
GET /notifications/:id
X-Api-Key: iphone-uuid-abc123
```

---

### Update Notification
```
PATCH /notifications/:id
X-Api-Key: iphone-uuid-abc123

{ "severity": "info", "description": "Actualización: sin réplicas reportadas" }
```

---

### Deactivate Notification
```
DELETE /notifications/:id
X-Api-Key: iphone-uuid-abc123
```

---

## Redis Key Structure

| Key | Type | Content |
|-----|------|---------|
| `profile:{device_id}` | String | JSON profile |
| `notification:{id}` | String | JSON notification |
| `notifications:all` | ZSet | All notification IDs (score = timestamp) |
| `notifications:type:{event_type}` | ZSet | IDs by event type |
| `notifications:severity:{level}` | ZSet | IDs by severity |
