export function createKeycap(key) {
  const cap = document.createElement("kbd");
  cap.className = "keycap";
  const face = document.createElement("span");
  face.className = "keycap-face";
  face.textContent = key;
  cap.append(face);
  return cap;
}

export function createKeyChord(keys) {
  const chord = document.createElement("span");
  chord.className = "keycap-chord";
  keys.forEach((key, index) => {
    if (index) chord.append(" + ");
    chord.append(createKeycap(key));
  });
  return chord;
}
