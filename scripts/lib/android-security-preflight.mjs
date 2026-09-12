const MAX_DISPLAY_TEXT = 120;
const MAX_LISTED_DEVICES = 5;

function boundedDisplay(value) {
  const sanitised = [...String(value)].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? "?" : character;
  }).join("").trim();
  return sanitised.length <= MAX_DISPLAY_TEXT
    ? sanitised
    : `${sanitised.slice(0, MAX_DISPLAY_TEXT - 1)}…`;
}

function parseDevices(output) {
  return String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("List of devices attached"))
    .map((line) => {
      const [serial, state] = line.split(/\s+/u);
      return serial === undefined || state === undefined ? null : { serial, state };
    })
    .filter((device) => device !== null);
}

export function preflightAndroidSecurityTarget({ adb, serial, execute }) {
  let output;
  try {
    output = execute(adb, ["devices", "-l"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(
      "Android security test preflight could not run ADB. Install Android SDK platform-tools or set ADB to the executable path.",
    );
  }

  const devices = parseDevices(output);
  const target = devices.find((device) => device.serial === serial);
  const displaySerial = boundedDisplay(serial);
  if (target === undefined) {
    const available = devices
      .slice(0, MAX_LISTED_DEVICES)
      .map((device) => `${boundedDisplay(device.serial)}:${boundedDisplay(device.state)}`)
      .join(", ");
    throw new Error(
      `Android security test device ${displaySerial} is not listed. Start or connect the device, or set ANDROID_SERIAL.${available.length === 0 ? " No devices were reported." : ` Reported devices: ${available}.`}`,
    );
  }
  if (target.state === "device") return;
  if (target.state === "unauthorized") {
    throw new Error(
      `Android security test device ${displaySerial} is unauthorized. Unlock the device and authorize this computer for USB debugging, then retry.`,
    );
  }
  if (target.state === "offline") {
    throw new Error(
      `Android security test device ${displaySerial} is offline. Restart or reconnect the device and ADB, then retry.`,
    );
  }
  throw new Error(
    `Android security test device ${displaySerial} is not ready (state: ${boundedDisplay(target.state)}). Restore it to the device state and retry.`,
  );
}
