/**
 * Stands in for Atmos Core's service-loader.js inside Finance's frames:
 * library services are imported with atmos.library() (declared in
 * "permissions.invokes").
 */
import { atmos } from './frame.js';

export async function getServiceFileUrl(serviceId, filename) {
  return atmos.library(`service:${serviceId}`, filename).catch(error => {
    console.error(`[finance] service '${serviceId}' is unavailable:`, error.message);
    return null;
  });
}
