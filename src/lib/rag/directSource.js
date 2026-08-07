/**
 * Direct Source Reader — runtime entity discovery (zero hardcoding).
 *
 * Replaced entityMap.json with live filesystem scanning via discovery.js.
 * All functions re-exported from discovery.js for backward compatibility.
 */

export {
  readSourceDirect,
  buildDirectContext,
  resolveEntity,
} from './discovery.js';
