// Private sync of my spots across devices: Google sign-in + Firestore.
// Each person's spots live in users/{uid}/spots, which only that signed-in person can read or write
// (see firestore.rules). This config identifies the project; it is not a secret.
const firebaseConfig = {
  apiKey: "AIzaSyD4RrmR7AgmICbQ9lvTIGM8-ErGRFIIILk",
  authDomain: "svampkarta-37df1.firebaseapp.com",
  projectId: "svampkarta-37df1",
  storageBucket: "svampkarta-37df1.firebasestorage.app",
  messagingSenderId: "296371444791",
  appId: "1:296371444791:web:2fe95f3e05bb66c7a7f3b2",
};
const UPLOADED_KEY = "svampkartan.uploadedTo"; // accounts this device has already sent its local spots to

(function () {
  const setStatus = (text) => { $("syncStatus").textContent = text; };
  if (!window.firebase) {
    setStatus("Sync is unavailable right now. Your spots are still saved on this device.");
    return;
  }
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  // Keeps a copy on the device so the app works without signal; writes sync when back online.
  db.enablePersistence({ synchronizeTabs: true }).catch(() => {});

  const clean = (s) => JSON.parse(JSON.stringify(s)); // Firestore rejects undefined values
  const showError = (e) => setStatus(e.code === "permission-denied"
    ? "The database refused access. Check that the Firestore rules are published."
    : `Sync problem: ${e.message}`);

  function writeAll(col, list) {
    const commits = [];
    for (let i = 0; i < list.length; i += 400) {
      const batch = db.batch();
      list.slice(i, i + 400).forEach((s) => batch.set(col.doc(s.id), clean(s)));
      commits.push(batch.commit());
    }
    return Promise.all(commits);
  }

  function renderAccount(user) {
    $("signInBtn").hidden = !!user;
    $("signOutBtn").hidden = !user;
    $("accountText").textContent = user
      ? `Signed in as ${user.email}. Your spots are private and synced.`
      : "Sign in to keep your spots private and synced across your devices.";
  }

  $("signInBtn").onclick = async () => {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(provider);
    } catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
        await auth.signInWithRedirect(provider);
      } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
        setStatus(`Sign-in failed: ${e.message}`);
      }
    }
  };
  $("signOutBtn").onclick = () => auth.signOut();

  let unsubscribers = [];
  auth.onAuthStateChanged((user) => {
    unsubscribers.forEach((stop) => stop());
    unsubscribers = [];
    renderAccount(user);
    if (!user) {
      if (cloud) {
        // Just signed out: don't leave this account's spots behind on the device.
        cloud = null;
        spots = [];
        saveSpots(); renderSpeciesList(); renderSpots();
      }
      setStatus("");
      return;
    }

    const col = db.collection("users").doc(user.uid).collection("spots");
    const prefs = db.collection("users").doc(user.uid).collection("settings").doc("prefs");
    cloud = {
      save: (list) => { writeAll(col, list).catch(showError); },
      remove: (id) => { col.doc(id).delete().catch(showError); },
      saveColors: (c) => { prefs.set({ colors: c }, { merge: true }).catch(showError); },
    };

    // First sign-in on this device: send up the spots saved here before sync existed.
    const uploaded = new Set(readJson(UPLOADED_KEY, []));
    if (!uploaded.has(user.uid)) {
      const local = [...spots];
      const markDone = () => { uploaded.add(user.uid); writeJson(UPLOADED_KEY, [...uploaded]); };
      if (local.length) {
        setStatus(`Uploading ${local.length} spots from this device…`);
        writeAll(col, local).then(markDone).catch(showError);
      } else {
        markDone();
      }
    }

    setStatus("Loading your spots…");
    unsubscribers.push(col.onSnapshot({ includeMetadataChanges: true }, (snap) => {
      spots = snap.docs.map((d) => d.data());
      spots.forEach((s) => ensureSpecies(s.speciesId, s.species));
      saveSpots(); renderSpeciesList(); renderSpots();
      setStatus(snap.metadata.hasPendingWrites
        ? "Saved on this device. Will sync when you're online."
        : snap.metadata.fromCache ? `Offline · ${spots.length} spots on this device` : `Synced · ${spots.length} spots`);
    }, showError));

    // Species colors follow the account too. The first device to sign in seeds them.
    unsubscribers.push(prefs.onSnapshot((doc) => {
      const remote = doc.data()?.colors;
      if (!remote) {
        if (Object.keys(colors).length) cloud.saveColors(colors);
        return;
      }
      const changed = [...new Set([...Object.keys(remote), ...Object.keys(colors)])].filter((id) => remote[id] !== colors[id]);
      if (!changed.length) return;
      colors = { ...remote };
      writeJson(COLORS_KEY, colors);
      changed.forEach((id) => recolor(id));
    }, showError));
  });
})();
