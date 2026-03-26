import OpenAI from 'openai';

let _client: OpenAI | null = null;

function getClient(apiKey: string): OpenAI {
  if (!_client) {
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export async function generateEmbedding(text: string, apiKey: string): Promise<number[]> {
  const client = getClient(apiKey);
  const input = text.slice(0, 8000); // text-embedding-3-small limit

  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input,
  });

  return response.data[0].embedding;
}

export async function generateEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  const client = getClient(apiKey);
  const inputs = texts.map(t => t.slice(0, 8000));

  // Batch up to 100 at a time
  const results: number[][] = [];
  for (let i = 0; i < inputs.length; i += 100) {
    const batch = inputs.slice(i, i + 100);
    const response = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch,
    });
    results.push(...response.data.map(d => d.embedding));
  }

  return results;
}
