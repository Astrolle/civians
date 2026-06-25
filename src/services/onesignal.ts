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
 * Find all device_ids within RADIUS_KM of a given coordinate.
 * Uses the Haversine approximation directly in SQL.
 * Only returns devices that have a GPS position set.
 */
async function findNearbyDeviceIds(lng: number, lat: number): Promise<string[]> {
  const db = getReadDB();

  // Haversine in SQL (SQLite compatible)
  // Distance in km between two points
  const result = await db.execute({
    sql: `
      SELECT device_id
      FROM profiles
      WHERE latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND (
          6371 * 2 * ASIN(SQRT(
            POWER(SIN((RADIANS(latitude)  - RADIANS(:lat)) / 2), 2) +
            COS(RADIANS(:lat)) * COS(RADIANS(latitude)) *
            POWER(SIN((RADIANS(longitude) - RADIANS(:lng)) / 2), 2)
          ))
        ) <= :radius
    `,
    args: { lat, lng, radius: RADIUS_KM },
  });

  return result.rows.map((row) => row.device_id as string);
}

/**
 * Send a push notification via OneSignal to all users within 5km
 * of the given coordinates.
 */
export async function sendPushToNearbyUsers(
  coordinates: [number, number],  // [lng, lat]
  payload: PushPayload,
): Promise<{ sent: number; onesignal_id?: string }> {
  const [lng, lat] = coordinates;

  const deviceIds = await findNearbyDeviceIds(lng, lat);

  if (deviceIds.length === 0) {
    console.log(`[OneSignal] No users found within ${RADIUS_KM}km of [${lng}, ${lat}]`);
    return { sent: 0 };
  }

  // Batch in chunks of 2000 (OneSignal limit per call is 20k but we stay conservative)
  const CHUNK_SIZE = 2000;
  let totalSent = 0;
  let lastOnesignalId: string | undefined;

  for (let i = 0; i < deviceIds.length; i += CHUNK_SIZE) {
    const chunk = deviceIds.slice(i, i + CHUNK_SIZE);

    const body = {
      app_id: process.env.ONESIGNAL_APP_ID!,
      // Target users by their external_id (= our device_id)
      include_aliases: {
        external_id: chunk,
      },
      target_channel: 'push',
      headings: { en: payload.title },
      contents: { en: payload.body },
      // Pass full notification data so the app can deep-link
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
        console.log(`[OneSignal] Sent to ${chunk.length} users (batch ${Math.floor(i / CHUNK_SIZE) + 1}), id=${response.data.id}`);
      } else {
        console.warn('[OneSignal] Batch returned no id:', response.data);
      }
    } catch (err: any) {
      console.error('[OneSignal] Push failed:', err?.response?.data || err.message);
    }
  }

  return { sent: totalSent, onesignal_id: lastOnesignalId };
}
