import { createApp, h, ref } from "vue";
import MangaReader from "/src/components/MangaReader.vue";
import { putImageBlob } from "/src/utils/galleryDB.js";
import "/src/style.css";

const options = window.readerFixture;
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><rect width="600" height="900" fill="#94b2d8"/></svg>';
const imageBlob = new Blob([image], { type: "image/svg+xml" });
const entries = options.entries;
if (options.seedCache) {
  const cachedEntries = entries.slice(0, options.seedCacheCount ?? entries.length);
  await Promise.all(cachedEntries.map((entry) => putImageBlob(entry.telegram.file_id_lossy || entry.telegram.file_id, imageBlob)));
}
if (options.reuseBlobs) {
  entries.forEach((entry) => {
    entry.src = URL.createObjectURL(imageBlob);
    entry.displayFileId = entry.telegram.file_id_lossy || entry.telegram.file_id;
  });
}
window.revokedImageUrls = [];
const revokeObjectURL = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (source) => {
  window.revokedImageUrls.push(source);
  revokeObjectURL(source);
};
createApp({
  setup() {
    const visible = ref(true);
    const currentIndex = ref(0);
    return () => [
      h("button", { onClick: () => { visible.value = true; } }, "重新打开"),
      visible.value ? h(MangaReader, {
        entries,
        currentIndex: currentIndex.value,
        onSetIndex: (index) => { currentIndex.value = index; },
        onClose: () => { visible.value = false; }
      }) : null
    ];
  }
}).mount("#fixture");
