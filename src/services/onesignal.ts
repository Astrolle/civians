import axios from 'axios';
import { getReadDB } from './db';

const ONESIGNAL_API_URL = 'https://api.onesignal.com/notifications?c=push';
const RADIUS_KM = 5;

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
}

/**
 * Find device_ids within RADIUS_KM of [lng, lat], excluding the sender.
 * Logs each candidate with their computed distance for debugging.
 */
async function findNearbyDeviceIds(
  lng: number,
  lat: number,
  excludeDeviceId: string,
): Promise<string[]> {
  const db = getReadDB();

  // Fetch candidates that have GPS set and are not the sender
  // Compute distance in the SELECT so we can log it
  const result = await db.execute({
    sql: `
      SELECT
        device_id,
        latitude,
        longitude,
        ROUND(
          6371 * 2 * ASIN(SQRT(
            POWER(SIN((RADIANS(latitude)  - RADIANS(:lat)) / 2), 2) +
            COS(RADIANS(:lat)) * COS(RADIANS(latitude)) *
            POWER(SIN((RADIANS(longitude) - RADIANS(:lng)) / 2), 2)
          )), 3
        ) AS dist_km
      FROM profiles
      WHERE latitude  IS NOT NULL
        AND longitude IS NOT NULL
        AND device_id != :excludeDeviceId
    `,
    args: { lat, lng, excludeDeviceId },
  });

  console.log(`[OneSignal] Push origin: [lng=${lng}, lat=${lat}], excluding: ${excludeDeviceId}`);
  console.log(`[OneSignal] Candidates found: ${result.rows.length}`);

  const nearby: string[] = [];

  for (const row of result.rows) {
    const dist = Number(row.dist_km);
    console.log(`[OneSignal]   device=${row.device_id} dist=${dist}km`);
    if (dist <= RADIUS_KM) {
      nearby.push(row.device_id as string);
    }
  }

  console.log(`[OneSignal] Within ${RADIUS_KM}km: ${nearby.length} user(s)`);
  return nearby;
}

export async function sendPushToNearbyUsers(
  coordinates: [number, number],  // [lng, lat]
  payload: PushPayload,
  senderDeviceId: string,
): Promise<{ sent: number; onesignal_id?: string }> {
  const [lng, lat] = coordinates;

  // Guard: coordinates must be valid numbers
  if (isNaN(lng) || isNaN(lat)) {
    console.error('[OneSignal] Invalid coordinates — push aborted', { lng, lat });
    return { sent: 0 };
  }

  const deviceIds = await findNearbyDeviceIds(lng, lat, senderDeviceId);

  if (deviceIds.length === 0) {
    console.log(`[OneSignal] No users within ${RADIUS_KM}km to notify.`);
    return { sent: 0 };
  }

  const CHUNK_SIZE = 2000;
  let totalSent = 0;
  let lastOnesignalId: string | undefined;

  for (let i = 0; i < deviceIds.length; i += CHUNK_SIZE) {
    const chunk = deviceIds.slice(i, i + CHUNK_SIZE);

    const body = {
      app_id: process.env.ONESIGNAL_APP_ID!,
      include_aliases: { external_id: chunk },
      target_channel: 'push',
      headings: { en: payload.title },
      contents: { en: payload.body },
      data: payload.data ?? {},
      priority: 10,
      ios_interruption_level: 'time_sensitive',
    };

    try {
      const response = await axios.post(ONESIGNAL_API_URL, body, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Key ${process.env.ONESIGNAL_API_KEY!}`,
        },
      });

      if (response.data?.id) {
        totalSent += chunk.length;
        lastOnesignalId = response.data.id;
        console.log(`[OneSignal] Sent to ${chunk.length} user(s), onesignal_id=${response.data.id}`);
      } else {
        console.warn('[OneSignal] Unexpected response:', response.data);
      }
    } catch (err: any) {
      console.error('[OneSignal] Push failed:', err?.response?.data || err.message);
    }
  }

  return { sent: totalSent, onesignal_id: lastOnesignalId };
}
