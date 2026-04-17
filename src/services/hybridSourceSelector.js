function chooseBestSource(esp32Snapshot, mobileSnapshot, nowMs = Date.now()) {
  if (esp32Snapshot?.timestamp) {
    const esp32Ts = new Date(esp32Snapshot.timestamp).getTime();
    if (nowMs - esp32Ts <= 10000) {
      return {
        source: "esp32",
        lat: esp32Snapshot.lat,
        lng: esp32Snapshot.lng,
        speed: esp32Snapshot.speed || 0,
        timestamp: esp32Snapshot.timestamp,
      };
    }
  }

  if (mobileSnapshot?.timestamp) {
    return {
      source: "mobile",
      lat: mobileSnapshot.lat,
      lng: mobileSnapshot.lng,
      speed: mobileSnapshot.speed || 0,
      timestamp: mobileSnapshot.timestamp,
    };
  }

  return null;
}

module.exports = {
  chooseBestSource,
};
