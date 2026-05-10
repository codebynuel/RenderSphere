async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export { readResponseJson };
