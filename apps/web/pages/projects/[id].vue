<script setup lang="ts">
type Project = { id: string; name: string; description: string | null; status: string };
type Episode = { id: string; title: string; episodeNumber: number; status: string };
type Script = { id: string; content: string; version: number };
type Asset = { id: string; projectId: string; name: string; description: string | null; visualDescription: string | null };
type Scene = { id: string; episodeId: string; name: string; description: string | null; orderIndex: number };
type Shot = { id: string; sceneId: string; orderIndex: number; purpose: string | null; shotType: string | null; framing: string | null; cameraMovement: string | null; cameraAngle: string | null; prompt: string | null; visualDescription: string | null; actionDescription: string | null; dialogue: string | null; transition: string | null; productionNotes: string | null; duration: number | null; status: string };
type Version = { id: string; shotId: string; version: number; prompt: string | null; status: string; duration: number | null; productionReady: number };
type Link = { id: string; shotId: string; characterId: string };
type AssetLink = { id: string; shotId: string; locationId?: string; propId?: string };
type MediaAsset = { id: string; projectId: string; name: string; type: string; status: string; description: string | null; approvedVersionId: string | null };
type ListResponse<T> = { data: T[] };
type SingleResponse<T> = { data: T };

const config = useRuntimeConfig();
const route = useRoute();
const router = useRouter();
const base = `${config.public.apiBase}/api/v1`;
const project = ref<Project | null>(null);
const episodes = ref<Episode[]>([]);
const scripts = ref<Script[]>([]);
const characters = ref<Asset[]>([]);
const locations = ref<Asset[]>([]);
const props = ref<Asset[]>([]);
const scenes = ref<Scene[]>([]);
const shots = ref<Shot[]>([]);
const versions = ref<Version[]>([]);
const assignedCharacters = ref<Link[]>([]);
const assignedLocations = ref<AssetLink[]>([]);
const assignedProps = ref<AssetLink[]>([]);
const mediaAssets = ref<MediaAsset[]>([]);
const selectedEpisode = ref<Episode | null>(null);
const selectedScene = ref<Scene | null>(null);
const selectedShot = ref<Shot | null>(null);
const tab = ref("episodes");
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const formError = ref("");
const projectForm = reactive({ name: "", description: "", status: "" });

const episodeForm = reactive({ title: "", episodeNumber: 1, status: "draft" });
const scriptForm = reactive({ content: "", version: 1 });
const assetForm = reactive({ name: "", description: "", visualDescription: "" });
const mediaAssetForm = reactive({ name: "", type: "image", description: "" });
const sceneForm = reactive({ name: "", description: "", orderIndex: 1 });
const shotForm = reactive({ orderIndex: 1, purpose: "", shotType: "", framing: "", cameraMovement: "", cameraAngle: "", prompt: "", visualDescription: "", actionDescription: "", dialogue: "", transition: "", productionNotes: "", duration: 0, status: "pending" });
const versionForm = reactive({ version: 1, prompt: "", status: "pending", duration: 0, productionReady: 0 });
const editing = reactive<Record<string, string | null>>({ episode: null, script: null, character: null, location: null, prop: null, scene: null, shot: null, version: null });

function messageFromError(value: unknown, fallback: string) {
  const data = value && typeof value === "object" && "data" in value ? value.data : null;
  const errorValue = data && typeof data === "object" && "error" in data ? data.error : null;
  return errorValue && typeof errorValue === "object" && "message" in errorValue && typeof errorValue.message === "string" ? errorValue.message : fallback;
}
function clearFormError() { formError.value = ""; }
async function request<T>(path: string, options?: Parameters<typeof $fetch<T>>[1]) { return $fetch<T>(`${base}${path}`, options); }
async function remove(path: string, label: string, after: () => Promise<void>) {
  if (!window.confirm(`Delete this ${label}? This cannot be undone.`)) return;
  try { await request(path, { method: "DELETE" }); await after(); } catch (cause) { formError.value = messageFromError(cause, `Unable to delete ${label}.`); }
}
function nullable(value: string) { return value.trim() || null; }

async function loadProject() {
  loading.value = true; error.value = "";
  try {
    const response = await request<SingleResponse<Project>>(`/projects/${route.params.id}`);
    project.value = response.data;
    projectForm.name = response.data.name; projectForm.description = response.data.description ?? ""; projectForm.status = response.data.status;
    const [episodeResponse, characterResponse, locationResponse, propResponse, mediaResponse] = await Promise.all([
      request<ListResponse<Episode>>(`/projects/${route.params.id}/episodes`),
      request<ListResponse<Asset>>(`/projects/${route.params.id}/characters`),
      request<ListResponse<Asset>>(`/projects/${route.params.id}/locations`),
      request<ListResponse<Asset>>(`/projects/${route.params.id}/props`),
      request<ListResponse<MediaAsset>>(`/projects/${route.params.id}/assets`),
    ]);
    episodes.value = episodeResponse.data;
    characters.value = characterResponse.data;
    locations.value = locationResponse.data;
    props.value = propResponse.data;
    mediaAssets.value = mediaResponse.data;
    if (episodes.value[0]) await selectEpisode(episodes.value[0]);
  } catch (cause) { error.value = messageFromError(cause, "Unable to load this production workspace."); } finally { loading.value = false; }
}
async function loadMediaAssets() {
  try {
    const res = await request<ListResponse<MediaAsset>>(`/projects/${route.params.id}/assets`);
    mediaAssets.value = res.data;
  } catch (cause) {
    console.error(cause);
  }
}
async function saveMediaAsset() {
  saving.value = true;
  clearFormError();
  try {
    await request<SingleResponse<MediaAsset>>(`/projects/${route.params.id}/assets`, {
      method: "POST",
      body: {
        name: mediaAssetForm.name,
        type: mediaAssetForm.type,
        description: nullable(mediaAssetForm.description),
      },
    });
    mediaAssetForm.name = "";
    mediaAssetForm.description = "";
    await loadMediaAssets();
  } catch (cause) {
    formError.value = messageFromError(cause, "Unable to save media asset.");
  } finally {
    saving.value = false;
  }
}
async function selectEpisode(episode: Episode) {
  selectedEpisode.value = episode; selectedScene.value = null; selectedShot.value = null; shots.value = []; versions.value = []; assignedCharacters.value = []; assignedLocations.value = []; assignedProps.value = [];
  try {
    const [scriptResponse, sceneResponse, characterResponse, locationResponse, propResponse] = await Promise.all([
      request<ListResponse<Script>>(`/episodes/${episode.id}/script`), request<ListResponse<Scene>>(`/episodes/${episode.id}/scenes`),
      request<ListResponse<Asset>>(`/episodes/${episode.id}/characters`), request<ListResponse<Asset>>(`/episodes/${episode.id}/locations`), request<ListResponse<Asset>>(`/episodes/${episode.id}/props`),
    ]);
    scripts.value = scriptResponse.data; scenes.value = sceneResponse.data; characters.value = characterResponse.data; locations.value = locationResponse.data; props.value = propResponse.data;
  } catch (cause) { formError.value = messageFromError(cause, "Unable to load the episode."); }
}
async function selectScene(scene: Scene) {
  selectedScene.value = scene; selectedShot.value = null; versions.value = [];
  try { shots.value = (await request<ListResponse<Shot>>(`/scenes/${scene.id}/shots`)).data; } catch (cause) { formError.value = messageFromError(cause, "Unable to load shots."); }
}
async function selectShot(shot: Shot) {
  selectedShot.value = shot;
  try {
    const [versionResponse, characterResponse, locationResponse, propResponse] = await Promise.all([request<ListResponse<Version>>(`/shots/${shot.id}/versions`), request<ListResponse<Link>>(`/shots/${shot.id}/characters`), request<ListResponse<AssetLink>>(`/shots/${shot.id}/locations`), request<ListResponse<AssetLink>>(`/shots/${shot.id}/props`)]);
    versions.value = versionResponse.data; assignedCharacters.value = characterResponse.data; assignedLocations.value = locationResponse.data; assignedProps.value = propResponse.data;
  } catch (cause) { formError.value = messageFromError(cause, "Unable to load shot details."); }
}
function fillEpisode(episode: Episode) { Object.assign(episodeForm, { title: episode.title, episodeNumber: episode.episodeNumber, status: episode.status }); editing.episode = episode.id; }
async function saveEpisode() {
  saving.value = true; clearFormError();
  try { const body = { title: episodeForm.title, episodeNumber: episodeForm.episodeNumber, status: episodeForm.status }; const response = editing.episode ? await request<SingleResponse<Episode>>(`/episodes/${editing.episode}`, { method: "PATCH", body }) : await request<SingleResponse<Episode>>(`/projects/${route.params.id}/episodes`, { method: "POST", body }); episodes.value = editing.episode ? episodes.value.map((item) => item.id === editing.episode ? response.data : item) : [...episodes.value, response.data]; editing.episode = null; episodeForm.title = ""; await selectEpisode(response.data); } catch (cause) { formError.value = messageFromError(cause, "Unable to save episode."); } finally { saving.value = false; }
}
async function saveProject() {
  saving.value = true; clearFormError();
  try { const response = await request<SingleResponse<Project>>(`/projects/${route.params.id}`, { method: "PATCH", body: { name: projectForm.name, description: nullable(projectForm.description), status: projectForm.status } }); project.value = response.data; projectForm.name = response.data.name; projectForm.description = response.data.description ?? ""; projectForm.status = response.data.status; } catch (cause) { formError.value = messageFromError(cause, "Unable to update project."); } finally { saving.value = false; }
}
async function deleteProject() {
  if (!window.confirm("Delete this project and its production data? This cannot be undone.")) return;
  try { await request(`/projects/${route.params.id}`, { method: "DELETE" }); await router.push("/"); } catch (cause) { formError.value = messageFromError(cause, "Unable to delete project."); }
}
function fillScript(script: Script) { Object.assign(scriptForm, { content: script.content, version: script.version }); editing.script = script.id; }
async function saveScript() {
  if (!selectedEpisode.value) return; saving.value = true; clearFormError();
  try { const body = { content: scriptForm.content, version: scriptForm.version }; const response = editing.script ? await request<SingleResponse<Script>>(`/scripts/${editing.script}`, { method: "PATCH", body }) : await request<SingleResponse<Script>>(`/episodes/${selectedEpisode.value.id}/script`, { method: "POST", body }); scripts.value = editing.script ? scripts.value.map((item) => item.id === editing.script ? response.data : item) : [...scripts.value, response.data]; editing.script = null; scriptForm.content = ""; } catch (cause) { formError.value = messageFromError(cause, "Unable to save script version."); } finally { saving.value = false; }
}
function fillAsset(kind: "character" | "location" | "prop", item: Asset) { editing[kind] = item.id; Object.assign(assetForm, { name: item.name, description: item.description ?? "", visualDescription: item.visualDescription ?? "" }); }
async function saveAsset(kind: "character" | "location" | "prop") {
  const collection = kind === "character" ? characters : kind === "location" ? locations : props; const endpoint = kind === "character" ? "characters" : kind === "location" ? "locations" : "props"; saving.value = true; clearFormError();
  try { const body = { name: assetForm.name, description: nullable(assetForm.description), visualDescription: nullable(assetForm.visualDescription) }; const response = editing[kind] ? await request<SingleResponse<Asset>>(`/${endpoint}/${editing[kind]}`, { method: "PATCH", body }) : await request<SingleResponse<Asset>>(`/projects/${route.params.id}/${endpoint}`, { method: "POST", body }); collection.value = editing[kind] ? collection.value.map((item) => item.id === editing[kind] ? response.data : item) : [...collection.value, response.data]; editing[kind] = null; assetForm.name = ""; assetForm.description = ""; assetForm.visualDescription = ""; } catch (cause) { formError.value = messageFromError(cause, `Unable to save ${kind}.`); } finally { saving.value = false; }
}
function fillScene(scene: Scene) { editing.scene = scene.id; Object.assign(sceneForm, { name: scene.name, description: scene.description ?? "", orderIndex: scene.orderIndex }); }
async function saveScene() {
  if (!selectedEpisode.value) return; saving.value = true; clearFormError();
  try { const body = { name: sceneForm.name, description: nullable(sceneForm.description), orderIndex: sceneForm.orderIndex }; const response = editing.scene ? await request<SingleResponse<Scene>>(`/scenes/${editing.scene}`, { method: "PATCH", body }) : await request<SingleResponse<Scene>>(`/episodes/${selectedEpisode.value.id}/scenes`, { method: "POST", body }); scenes.value = editing.scene ? scenes.value.map((item) => item.id === editing.scene ? response.data : item) : [...scenes.value, response.data].sort((a, b) => a.orderIndex - b.orderIndex); editing.scene = null; sceneForm.name = ""; await selectScene(response.data); } catch (cause) { formError.value = messageFromError(cause, "Unable to save scene."); } finally { saving.value = false; }
}
function fillShot(shot: Shot) { editing.shot = shot.id; Object.assign(shotForm, { ...shot, purpose: shot.purpose ?? "", shotType: shot.shotType ?? "", framing: shot.framing ?? "", cameraMovement: shot.cameraMovement ?? "", cameraAngle: shot.cameraAngle ?? "", prompt: shot.prompt ?? "", visualDescription: shot.visualDescription ?? "", actionDescription: shot.actionDescription ?? "", dialogue: shot.dialogue ?? "", transition: shot.transition ?? "", productionNotes: shot.productionNotes ?? "", duration: shot.duration ?? 0 }); }
async function saveShot() {
  if (!selectedScene.value) return; saving.value = true; clearFormError();
  try { const body = { ...shotForm, duration: shotForm.duration || null, purpose: nullable(shotForm.purpose), shotType: nullable(shotForm.shotType), framing: nullable(shotForm.framing), cameraMovement: nullable(shotForm.cameraMovement), cameraAngle: nullable(shotForm.cameraAngle), prompt: nullable(shotForm.prompt), visualDescription: nullable(shotForm.visualDescription), actionDescription: nullable(shotForm.actionDescription), dialogue: nullable(shotForm.dialogue), transition: nullable(shotForm.transition), productionNotes: nullable(shotForm.productionNotes) }; const response = editing.shot ? await request<SingleResponse<Shot>>(`/shots/${editing.shot}`, { method: "PATCH", body }) : await request<SingleResponse<Shot>>(`/scenes/${selectedScene.value.id}/shots`, { method: "POST", body }); await selectScene(selectedScene.value); if (editing.shot) await selectShot(response.data); editing.shot = null; } catch (cause) { formError.value = messageFromError(cause, "Unable to save shot."); } finally { saving.value = false; }
}
function fillVersion(version: Version) { editing.version = version.id; Object.assign(versionForm, { version: version.version, prompt: version.prompt ?? "", status: version.status, duration: version.duration ?? 0, productionReady: version.productionReady }); }
async function saveVersion() {
  if (!selectedShot.value) return; saving.value = true; clearFormError();
  try { const body = { version: versionForm.version, prompt: nullable(versionForm.prompt), status: versionForm.status, duration: versionForm.duration || null, productionReady: versionForm.productionReady }; const response = editing.version ? await request<SingleResponse<Version>>(`/shot-versions/${editing.version}`, { method: "PATCH", body }) : await request<SingleResponse<Version>>(`/shots/${selectedShot.value.id}/versions`, { method: "POST", body }); versions.value = editing.version ? versions.value.map((item) => item.id === editing.version ? response.data : item) : [...versions.value, response.data].sort((a, b) => a.version - b.version); editing.version = null; } catch (cause) { formError.value = messageFromError(cause, "Unable to save shot version."); } finally { saving.value = false; }
}
async function assignCharacter(characterId: string) { if (!selectedShot.value || !characterId) return; try { const response = await request<SingleResponse<Link>>(`/shots/${selectedShot.value.id}/characters`, { method: "POST", body: { characterId } }); assignedCharacters.value.push(response.data); } catch (cause) { formError.value = messageFromError(cause, "Unable to assign character."); } }
async function assignLocation(locationId: string) { if (!selectedShot.value || !locationId) return; try { const response = await request<SingleResponse<AssetLink>>(`/shots/${selectedShot.value.id}/locations`, { method: "POST", body: { locationId } }); assignedLocations.value.push(response.data); } catch (cause) { formError.value = messageFromError(cause, "Unable to assign location."); } }
async function assignProp(propId: string) { if (!selectedShot.value || !propId) return; try { const response = await request<SingleResponse<AssetLink>>(`/shots/${selectedShot.value.id}/props`, { method: "POST", body: { propId } }); assignedProps.value.push(response.data); } catch (cause) { formError.value = messageFromError(cause, "Unable to assign prop."); } }
async function unassignCharacter(link: Link) { if (!selectedShot.value) return; await remove(`/shots/${selectedShot.value.id}/characters/${link.characterId}`, "character assignment", async () => { assignedCharacters.value = assignedCharacters.value.filter((item) => item.id !== link.id); }); }
async function unassignLocation(link: AssetLink) { if (!selectedShot.value || !link.locationId) return; await remove(`/shots/${selectedShot.value.id}/locations/${link.locationId}`, "location assignment", async () => { assignedLocations.value = assignedLocations.value.filter((item) => item.id !== link.id); }); }
async function unassignProp(link: AssetLink) { if (!selectedShot.value || !link.propId) return; await remove(`/shots/${selectedShot.value.id}/props/${link.propId}`, "prop assignment", async () => { assignedProps.value = assignedProps.value.filter((item) => item.id !== link.id); }); }
async function deleteEpisode(episode: Episode) { await remove(`/episodes/${episode.id}`, "episode", async () => { episodes.value = episodes.value.filter((item) => item.id !== episode.id); selectedEpisode.value = null; scenes.value = []; }); }
async function deleteScene(scene: Scene) { await remove(`/scenes/${scene.id}`, "scene", async () => { scenes.value = scenes.value.filter((item) => item.id !== scene.id); if (selectedScene.value?.id === scene.id) selectedScene.value = null; }); }
async function deleteShot(shot: Shot) { await remove(`/shots/${shot.id}`, "shot", async () => { shots.value = shots.value.filter((item) => item.id !== shot.id); if (selectedShot.value?.id === shot.id) selectedShot.value = null; }); }
async function deleteAsset(kind: "character" | "location" | "prop", item: Asset) { const endpoint = kind === "character" ? "characters" : kind === "location" ? "locations" : "props"; const collection = kind === "character" ? characters : kind === "location" ? locations : props; await remove(`/${endpoint}/${item.id}`, kind, async () => { collection.value = collection.value.filter((entry) => entry.id !== item.id); }); }
async function deleteScript(script: Script) { await remove(`/scripts/${script.id}`, "script version", async () => { scripts.value = scripts.value.filter((item) => item.id !== script.id); }); }
async function deleteVersion(version: Version) { await remove(`/shot-versions/${version.id}`, "shot version", async () => { versions.value = versions.value.filter((item) => item.id !== version.id); }); }

onMounted(loadProject);
</script>

<template>
  <main class="page">
    <NuxtLink to="/" class="back">← Projects</NuxtLink>
    <p v-if="loading" class="muted" role="status">Loading production workspace…</p>
    <p v-else-if="error" class="error" role="alert">{{ error }}</p>
    <template v-else-if="project">
      <header class="header"><p class="eyebrow">Creative production</p><h1>{{ project.name }}</h1><p class="muted">{{ project.description || "Plan episodes, assets, scenes, shots, and revisions." }}</p></header>
      <section class="panel project-panel"><div class="section-heading"><h2>Project information</h2><button class="icon-button danger" @click="deleteProject">Delete project</button></div><form class="form" @submit.prevent="saveProject"><input v-model="projectForm.name" required maxlength="255" placeholder="Project name" /><textarea v-model="projectForm.description" rows="2" placeholder="Description" /><input v-model="projectForm.status" required maxlength="50" placeholder="Status" /><button :disabled="saving">{{ saving ? "Saving…" : "Save project" }}</button></form></section>
      <nav class="tabs" aria-label="Production sections"><button :class="{ active: tab === 'episodes' }" @click="tab = 'episodes'">Episodes & scripts</button><button :class="{ active: tab === 'assets' }" @click="tab = 'assets'">Creative assets</button><button :class="{ active: tab === 'media' }" @click="tab = 'media'">Media assets</button><button :class="{ active: tab === 'production' }" @click="tab = 'production'">Scenes & shots</button></nav>
      <p v-if="formError" class="error" role="alert">{{ formError }}</p>

      <section v-if="tab === 'media'" class="section-grid">
        <div class="panel"><div class="section-heading"><h2>Add media asset</h2></div><form class="form" @submit.prevent="saveMediaAsset"><input v-model="mediaAssetForm.name" required maxlength="255" placeholder="Asset name" /><select v-model="mediaAssetForm.type"><option value="image">Image</option><option value="video">Video</option><option value="audio">Audio</option></select><textarea v-model="mediaAssetForm.description" rows="2" placeholder="Description" /><button :disabled="saving">{{ saving ? "Saving…" : "Add media asset" }}</button></form></div>
        <div class="panel"><div class="section-heading"><h2>Media assets</h2><span class="count">{{ mediaAssets.length }}</span></div><p v-if="!mediaAssets.length" class="empty muted">No media assets in this project yet.</p><ul class="item-list"><li v-for="media in mediaAssets" :key="media.id"><div><strong>{{ media.name }}</strong><small>{{ media.type }} · {{ media.status }}{{ media.description ? ` · ${media.description}` : '' }}</small></div></li></ul></div>
      </section>

      <section v-if="tab === 'episodes'" class="section-grid">
        <div class="panel"><div class="section-heading"><h2>Episodes</h2><span class="count">{{ episodes.length }}</span></div><form class="form" @submit.prevent="saveEpisode"><input v-model="episodeForm.title" required maxlength="255" placeholder="Episode title" /><input v-model.number="episodeForm.episodeNumber" type="number" min="1" required placeholder="Number" /><input v-model="episodeForm.status" required maxlength="50" placeholder="Status" /><button :disabled="saving">{{ editing.episode ? "Update episode" : "Add episode" }}</button></form><p v-if="!episodes.length" class="empty muted">No episodes yet. Add the first production unit above.</p><ul class="item-list"><li v-for="episode in episodes" :key="episode.id" :class="{ selected: selectedEpisode?.id === episode.id }"><button class="item-button" @click="selectEpisode(episode)"><strong>{{ episode.episodeNumber }}. {{ episode.title }}</strong><small>{{ episode.status }}</small></button><button class="icon-button" title="Edit episode" @click="fillEpisode(episode)">Edit</button><button class="icon-button danger" title="Delete episode" @click="deleteEpisode(episode)">Delete</button></li></ul></div>
        <div class="panel"><div class="section-heading"><h2>{{ selectedEpisode ? selectedEpisode.title : "Select an episode" }}</h2></div><template v-if="selectedEpisode"><form class="form" @submit.prevent="saveScript"><textarea v-model="scriptForm.content" required rows="5" placeholder="Script content" /><input v-model.number="scriptForm.version" type="number" min="1" required placeholder="Version" /><button :disabled="saving">{{ editing.script ? "Update script" : "Add script version" }}</button></form><p v-if="!scripts.length" class="empty muted">No script versions for this episode.</p><ul class="item-list"><li v-for="script in scripts" :key="script.id"><div><strong>Version {{ script.version }}</strong><p class="preview">{{ script.content }}</p></div><button class="icon-button" @click="fillScript(script)">Edit</button><button class="icon-button danger" @click="deleteScript(script)">Delete</button></li></ul></template><p v-else class="empty muted">Choose an episode to manage its scripts.</p></div>
      </section>

      <section v-if="tab === 'assets'" class="asset-grid"><div v-for="(collection, kind) in { character: characters, location: locations, prop: props }" :key="kind" class="panel"><div class="section-heading"><h2>{{ kind }}s</h2><span class="count">{{ collection.length }}</span></div><form class="form" @submit.prevent="saveAsset(kind as 'character' | 'location' | 'prop')"><input v-model="assetForm.name" required maxlength="255" :placeholder="`${kind} name`" /><textarea v-model="assetForm.description" rows="2" placeholder="Description" /><textarea v-model="assetForm.visualDescription" rows="2" placeholder="Visual description" /><button :disabled="saving">{{ editing[kind] ? `Update ${kind}` : `Add ${kind}` }}</button></form><p v-if="!collection.length" class="empty muted">No {{ kind }} assets yet.</p><ul class="item-list"><li v-for="item in collection" :key="item.id"><div><strong>{{ item.name }}</strong><small>{{ item.visualDescription || item.description || "No production notes" }}</small></div><button class="icon-button" @click="fillAsset(kind as 'character' | 'location' | 'prop', item)">Edit</button><button class="icon-button danger" @click="deleteAsset(kind as 'character' | 'location' | 'prop', item)">Delete</button></li></ul></div></section>

      <section v-if="tab === 'production'" class="production-grid"><div class="panel"><div class="section-heading"><h2>{{ selectedEpisode ? `Scenes · ${selectedEpisode.title}` : "Scenes" }}</h2></div><p v-if="!selectedEpisode" class="empty muted">Select an episode in the Episodes tab first.</p><template v-else><form class="form" @submit.prevent="saveScene"><input v-model="sceneForm.name" required maxlength="255" placeholder="Scene name" /><input v-model.number="sceneForm.orderIndex" type="number" min="1" required placeholder="Order" /><textarea v-model="sceneForm.description" rows="2" placeholder="Production notes" /><button :disabled="saving">{{ editing.scene ? "Update scene" : "Add scene" }}</button></form><p v-if="!scenes.length" class="empty muted">No scenes yet. Add a scene to begin shot planning.</p><ul class="item-list"><li v-for="scene in scenes" :key="scene.id" :class="{ selected: selectedScene?.id === scene.id }"><button class="item-button" @click="selectScene(scene)"><strong>{{ scene.orderIndex }}. {{ scene.name }}</strong><small>{{ scene.description || "No notes" }}</small></button><button class="icon-button" @click="fillScene(scene)">Edit</button><button class="icon-button danger" @click="deleteScene(scene)">Delete</button></li></ul></template></div>
        <div class="panel"><div class="section-heading"><h2>{{ selectedScene ? `Shots · ${selectedScene.name}` : "Shots" }}</h2></div><p v-if="!selectedScene" class="empty muted">Select a scene to manage its shots.</p><template v-else><form class="form shot-form" @submit.prevent="saveShot"><input v-model.number="shotForm.orderIndex" type="number" min="1" required placeholder="Order" /><input v-model="shotForm.purpose" placeholder="Purpose" /><input v-model="shotForm.shotType" placeholder="Shot type" /><input v-model="shotForm.framing" placeholder="Framing" /><input v-model="shotForm.cameraMovement" placeholder="Camera movement" /><input v-model="shotForm.cameraAngle" placeholder="Camera angle" /><textarea v-model="shotForm.visualDescription" rows="2" placeholder="Visual description" /><textarea v-model="shotForm.actionDescription" rows="2" placeholder="Action description" /><textarea v-model="shotForm.dialogue" rows="2" placeholder="Dialogue" /><textarea v-model="shotForm.prompt" rows="2" placeholder="Generation prompt" /><input v-model.number="shotForm.duration" type="number" min="0" placeholder="Duration (seconds)" /><input v-model="shotForm.status" required maxlength="50" placeholder="Status" /><textarea v-model="shotForm.productionNotes" rows="2" placeholder="Production notes" /><button :disabled="saving">{{ editing.shot ? "Update shot" : "Add shot" }}</button></form><p v-if="!shots.length" class="empty muted">No shots yet. Add the first shot for this scene.</p><ul class="item-list"><li v-for="shot in shots" :key="shot.id" :class="{ selected: selectedShot?.id === shot.id }"><button class="item-button" @click="selectShot(shot)"><strong>{{ shot.orderIndex }}. {{ shot.shotType || "Shot" }}</strong><small>{{ shot.status }} · {{ shot.duration ?? "?" }}s</small></button><button class="icon-button" @click="fillShot(shot)">Edit</button><button class="icon-button danger" @click="deleteShot(shot)">Delete</button></li></ul></template></div>
        <div v-if="selectedShot" class="panel detail-panel"><div class="section-heading"><h2>Shot versions</h2><span class="ready" v-if="versions.some((version) => version.productionReady === 1)">Ready for generation</span></div><form class="form" @submit.prevent="saveVersion"><input v-model.number="versionForm.version" type="number" min="1" required placeholder="Version" /><textarea v-model="versionForm.prompt" rows="2" placeholder="Version prompt" /><input v-model="versionForm.status" required maxlength="50" placeholder="Status" /><input v-model.number="versionForm.duration" type="number" min="0" placeholder="Duration" /><label class="checkbox"><input v-model="versionForm.productionReady" type="checkbox" :true-value="1" :false-value="0" /> Production ready</label><button :disabled="saving">{{ editing.version ? "Update version" : "Add version" }}</button></form><p v-if="!versions.length" class="empty muted">No revisions yet. Create a version when the shot is ready to review.</p><ul class="item-list"><li v-for="version in versions" :key="version.id"><div><strong>Version {{ version.version }}</strong><small>{{ version.status }}{{ version.productionReady ? " · Ready for generation" : "" }}</small></div><button class="icon-button" @click="fillVersion(version)">Edit</button><button class="icon-button danger" @click="deleteVersion(version)">Delete</button></li></ul><div class="section-heading"><h2>Shot assignments</h2></div><label class="assign">Assign character<select @change="assignCharacter(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''"><option value="">Choose a character</option><option v-for="character in characters.filter((item) => !assignedCharacters.some((link) => link.characterId === item.id))" :key="character.id" :value="character.id">{{ character.name }}</option></select></label><ul class="assigned"><li v-for="link in assignedCharacters" :key="link.id">{{ characters.find((item) => item.id === link.characterId)?.name || link.characterId }} <button class="icon-button danger" @click="unassignCharacter(link)">Remove</button></li></ul><label class="assign">Assign location<select @change="assignLocation(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''"><option value="">Choose a location</option><option v-for="location in locations.filter((item) => !assignedLocations.some((link) => link.locationId === item.id))" :key="location.id" :value="location.id">{{ location.name }}</option></select></label><ul class="assigned"><li v-for="link in assignedLocations" :key="link.id">{{ locations.find((item) => item.id === link.locationId)?.name || link.locationId }} <button class="icon-button danger" @click="unassignLocation(link)">Remove</button></li></ul><label class="assign">Assign prop<select @change="assignProp(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''"><option value="">Choose a prop</option><option v-for="prop in props.filter((item) => !assignedProps.some((link) => link.propId === item.id))" :key="prop.id" :value="prop.id">{{ prop.name }}</option></select></label><ul class="assigned"><li v-for="link in assignedProps" :key="link.id">{{ props.find((item) => item.id === link.propId)?.name || link.propId }} <button class="icon-button danger" @click="unassignProp(link)">Remove</button></li></ul></div>
      </section>
    </template>
  </main>
</template>

<style scoped>
:global(body) { margin: 0; background: #f4f7f8; color: #17212b; font-family: system-ui, sans-serif; }
.page { max-width: 1400px; min-height: 100vh; margin: 0 auto; padding: 2rem 1.25rem 4rem; box-sizing: border-box; }
.back { color: #176b65; text-decoration: none; font-weight: 650; }.header { margin: 2rem 0 1.5rem; }.header h1 { margin: .25rem 0; font-size: clamp(2rem, 5vw, 3.5rem); }.header p { margin: 0; }.eyebrow { color: #d35b3e; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }.muted { color: #68777c; }.error { color: #a62e25; margin: 1rem 0; }.tabs { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1.25rem; }.tabs button { border: 1px solid #b9cdca; background: #fff; color: #245a56; }.tabs button.active { background: #176b65; color: #fff; }
.section-grid, .production-grid { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(320px, 1.2fr); gap: 1rem; align-items: start; }.production-grid { grid-template-columns: minmax(260px, .8fr) minmax(320px, 1.2fr) minmax(280px, .9fr); }.asset-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }.panel { border: 1px solid #d4dfdd; border-radius: 8px; background: #fff; padding: 1.1rem; box-shadow: 0 5px 18px #173f3b0d; }.section-heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-bottom: 1rem; }.section-heading h2 { margin: 0; font-size: 1.15rem; }.count, .ready { border-radius: 999px; background: #e4f1ef; color: #176b65; padding: .2rem .55rem; font-size: .8rem; }.ready { background: #e7f3d9; color: #44711e; }
.form { display: grid; gap: .65rem; margin-bottom: 1rem; }.form input, .form textarea, select { box-sizing: border-box; width: 100%; border: 1px solid #b9cdca; border-radius: 5px; padding: .6rem; font: inherit; background: #fff; }.form textarea { resize: vertical; }.form button, .tabs button { border-radius: 5px; padding: .6rem .8rem; font: inherit; font-weight: 700; cursor: pointer; }.form button { border: 0; background: #176b65; color: #fff; }.form button:disabled { opacity: .6; cursor: wait; }.checkbox { display: flex; gap: .5rem; align-items: center; font-weight: 650; }.checkbox input { width: auto; }
.item-list { list-style: none; display: grid; gap: .5rem; padding: 0; margin: 0; }.item-list li { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: .35rem; border-top: 1px solid #e5eceb; padding-top: .55rem; }.item-list li.selected { border-left: 3px solid #d35b3e; padding-left: .45rem; }.item-button { display: grid; gap: .2rem; border: 0; background: transparent; text-align: left; padding: .25rem; color: inherit; cursor: pointer; }.item-button small, .item-list small { color: #68777c; }.icon-button { border: 1px solid #b9cdca; border-radius: 4px; background: #fff; padding: .35rem .45rem; cursor: pointer; color: #245a56; }.icon-button.danger { color: #a62e25; }.empty { border: 1px dashed #b9cdca; padding: .8rem; margin: .75rem 0; }.preview { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: .25rem 0 0; color: #68777c; }.assign { display: grid; gap: .4rem; margin-top: 1rem; font-weight: 650; }.assigned { margin: .75rem 0 0; padding-left: 1.2rem; color: #245a56; }
@media (max-width: 1000px) { .production-grid { grid-template-columns: minmax(260px, .8fr) minmax(320px, 1.2fr); }.detail-panel { grid-column: 1 / -1; } .asset-grid { grid-template-columns: 1fr; } }.shot-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }.shot-form textarea, .shot-form button { grid-column: 1 / -1; } @media (max-width: 680px) { .section-grid, .production-grid { grid-template-columns: 1fr; }.shot-form { grid-template-columns: 1fr; }.item-list li { grid-template-columns: 1fr auto; }.item-list li .danger { grid-column: 2; } }
</style>
