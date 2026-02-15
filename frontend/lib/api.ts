const BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export async function uploadLAS(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${BASE}/api/upload-las`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Upload failed (${res.status})`);
  }

  return res.json();
}

export async function getWellMetadata(fileId: number) {
  const res = await fetch(`${BASE}/api/well/${fileId}`);
  if (!res.ok) throw new Error("Failed to load well metadata");
  return res.json();
}

export async function getCurves(fileId: number) {
  const res = await fetch(`${BASE}/api/curves/${fileId}`);
  if (!res.ok) throw new Error("Failed to load curves");
  return res.json();
}

export async function getSamples(
  curveId: number,
  start: number,
  end: number
) {
  const res = await fetch(
    `${BASE}/api/samples/${curveId}?start=${start}&end=${end}`
  );
  if (!res.ok) throw new Error("Failed to load samples");
  return res.json();
}

export async function interpret(params: {
  file_id: number;
  depth_start: number;
  depth_end: number;
  curve_ids: number[];
}) {
  const res = await fetch(`${BASE}/api/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || "Interpretation failed");
  }
  return res.json();
}

export async function listFiles() {
  const res = await fetch(`${BASE}/api/files`);
  if (!res.ok) throw new Error("Failed to load files");
  return res.json();
}

export async function chat(
  message: string,
  fileId: number | null,
  context?: {
    selected_curve_names?: string[];
    depth_start?: number;
    depth_end?: number;
  }
) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      file_id: fileId,
      ...context,
    }),
  });
  if (!res.ok) throw new Error("Chat failed");
  return res.json();
}
