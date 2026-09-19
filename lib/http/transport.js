/**
 * The transport seam. This is the only module in the repository permitted
 * to perform network I/O. Everything else receives a transport.
 */

/**
 * @param {{ userAgent: string }} options
 * @returns {{ fetch(url: string, options?: object): Promise<object> }}
 */
export function createHttpTransport({ userAgent }) {
  return {
    async fetch(url, options = {}) {
      const headers = {
        'user-agent': userAgent,
        ...(options.headers ?? {}),
      };

      const response = await globalThis.fetch(url, {
        ...options,
        headers,
      });

      const body = await response.text();
      const responseHeaders = {};
      for (const [key, value] of response.headers) {
        responseHeaders[key.toLowerCase()] = value;
      }

      return {
        status: response.status,
        headers: responseHeaders,
        body,
        bytes: Buffer.byteLength(body, 'utf8'),
      };
    },
  };
}
