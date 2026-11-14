const listeners = {}
function on(event, callback) { (listeners[event] || (listeners[event] = [])).push(callback); return () => off(event, callback) }
function off(event, callback) { listeners[event] = (listeners[event] || []).filter(item => item !== callback) }
function emit(event, payload) { (listeners[event] || []).slice().forEach(callback => callback(payload)) }
module.exports = { on, off, emit }
