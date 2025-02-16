import { FetchEnd, NetworkData } from 'hint/dist/src/lib/types';
import { fetch } from '../shared/globals';
import { Events } from '../shared/types';
import { HttpHeaders } from '@hint/utils/dist/src/types/http-header';
import { getContentTypeData } from '@hint/utils/dist/src/content-type';

type ResolveNetworkData = (data: NetworkData) => void;

const mapResponseHeaders = (headers: Headers): HttpHeaders => {
    const responseHeaders: HttpHeaders = {};

    headers.forEach((val, key) => {
        responseHeaders[key] = val;
    });

    return responseHeaders;
};

const toNetworkData = async (target: string, headers: any, response: Response): Promise<NetworkData> => {
    const responseHeaders = mapResponseHeaders(response.headers);
    const { charset, mediaType } = getContentTypeData(null, target, responseHeaders, null as any);

    return {
        request: { headers: headers as any, url: target },
        response: {
            body: {
                content: await response.text(),
                rawContent: null as any, // TODO: Set once this supports `Blob`.
                rawResponse: null as any
            },
            charset: charset || '',
            headers: responseHeaders,
            hops: [],
            mediaType: mediaType || '',
            statusCode: response.status,
            url: target
        }
    };
};

export class Fetcher {
    private _fetches = new Map<string, ResolveNetworkData>();

    /**
     * Fetch a resource bypassing CORS restrictions on the response.
     */
    public fetch(target: string, headers?: any): Promise<NetworkData> {
        return new Promise(async (resolve, reject) => {
            this._fetches.set(target, resolve);

            /*
             * Trigger a fetch, but only resolve the response if it is not
             * missing headers due to CORS restrictions. For details see
             * https://www.chromium.org/Home/chromium-security/extension-content-script-fetches
             *
             * Otherwise, wait for the corresponding `FetchEnd` event to be
             * generated by the devtools `onRequestFinished` listener and
             * passed to `resolveFetch` below. Then return that instead as
             * it will have all response headers.
             */
            try {
                const response = await fetch(target, { headers });

                if (this._fetches.has(target) && response.type === 'basic') {
                    // Firefox code-path (can't use other path as fetch doesn't trigger onRequestFinished).
                    const data = await toNetworkData(target, headers, response);

                    resolve(data);
                    this._fetches.delete(target);
                } else {
                    // Chromium code-path (can't use other path as fetch applies CORS restrictions).
                }
            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Handle events received from the background script that were
     * indirectly triggered via a manual fetch.
     */
    public handle(events: Events): boolean {
        if (events.fetchEnd && this.isFetching(events.fetchEnd.resource)) {
            this.resolveFetch(events.fetchEnd);

            return true;
        }

        if (events.fetchStart && this.isFetching(events.fetchStart.resource)) {
            return true;
        }

        return false;
    }

    /**
     * Check if a received network request was triggered by a manual fetch.
     */
    private isFetching(resource: string) {
        return this._fetches.has(resource);
    }

    /**
     * Complete a manual fetch using the provided `FetchEnd` data generated
     * from the `browser.devtools.onRequestFinished` event.
     */
    private resolveFetch(event: FetchEnd) {
        const resolve = this._fetches.get(event.resource);

        if (resolve) {
            resolve(event);
            this._fetches.delete(event.resource);
        }
    }
}
