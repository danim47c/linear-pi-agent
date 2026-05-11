import { getLinearViewer } from "./linear.js";

const viewer = await getLinearViewer();
console.log(JSON.stringify({ ok: true, viewer }, null, 2));
