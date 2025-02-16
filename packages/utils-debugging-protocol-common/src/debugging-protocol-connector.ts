/**
 * @fileoverview Connector that uses the Chrome Debugging protocol
 * to load a site and do the traversing. It also uses request
 * (https:/github.com/request/request) to download the external
 * resources (JS, CSS, images).
 */

/*
 * ------------------------------------------------------------------------------
 * Requirements
 * ------------------------------------------------------------------------------
 */

import { URL } from 'url';
import { promisify } from 'util';

import * as cdp from 'chrome-remote-interface';

import * as lockfile from 'lockfile';
import filter = require('lodash/filter');

import { Crdp } from 'chrome-remote-debug-protocol';

import { contentType, debug as d, dom, HTMLDocument, HTMLElement, HttpHeaders, misc, network } from '@hint/utils';

import {
    BrowserInfo, IConnector, Engine,
    Event, FetchEnd, FetchError, ILauncher,
    Response, Request, NetworkData
} from 'hint';
import { normalizeHeaders, Requester } from '@hint/utils-connector-tools';

import { RequestResponse } from './request-response';

const { createHTMLDocument, getElementByUrl, traverse } = dom;
const { getType } = contentType;
const { cutString, delay } = misc;
const { isHTMLDocument } = network;
const debug: debug.IDebugger = d(__filename);
const lock = promisify(lockfile.lock) as (path: string, options: lockfile.Options) => Promise<void>;
const unlock = promisify(lockfile.unlock);

export class Connector implements IConnector {
    /** The final set of options resulting of merging the users, and default ones. */
    private _options: any;
    /** The original URL to collect. */
    private _href: string = '';
    /** The final URL after redirects (if they exist) */
    private _finalHref: string = '';
    /** The instance of hint that is using this connector. */
    private _server: Engine;
    /** The client to talk to the browser. */
    private _client!: Crdp.CrdpClient;
    /** A set of requests done by the connector to retrieve initial information more easily. */
    private _requests: Map<string, RequestResponse>;
    /** Indicates if there has been an error loading the page (e.g.: it doesn't exists). */
    private _errorWithPage: boolean = false;
    /** The DOM abstraction on top of adapter. */
    private _dom: HTMLDocument | undefined;
    private _originalDocument: HTMLDocument | undefined;
    /** A collection of requests with their initial data. */
    private _pendingResponseReceived: Function[];
    /** List of all the tabs used by the connector. */
    private _tabs: any[] = [];
    /** The amount of time before an event is going to be timedout. */
    private _timeout: number;
    /** Browser PID */
    private _pid: number | undefined;
    private _targetNetworkData!: NetworkData;
    private _launcher: ILauncher;
    /** Promise that gets resolved when the taget is downloaded. */
    private _waitForTarget: Promise<null>;
    /** Function to call when the target is downloaded. */
    private _targetReceived!: Function;
    /** Lock file. */
    private _lockFile = 'cdp.lock';
    /** Lock status. */
    private _isLocked = false;

    public static schema = {
        additionalProperties: false,
        properties: {
            ignoreHTTPSErrors: { type: 'boolean' },
            launcherOptions: { type: 'object' },
            waitFor: {
                minimum: 0,
                type: 'number'
            }
        }
    };

    public constructor(engine: Engine, config: object, launcher: ILauncher) {
        const defaultOptions = {
            ignoreHTTPSErrors: false,
            waitFor: 5000
        };

        this._server = engine;
        this._timeout = engine.timeout;

        this._options = Object.assign({}, defaultOptions, config);

        // TODO: setExtraHTTPHeaders with _headers in an async way.

        this._requests = new Map();
        this._pendingResponseReceived = [];

        this._launcher = launcher;

        this._waitForTarget = new Promise((resolve) => {
            this._targetReceived = resolve;
        });

        (engine as Engine<import('@hint/parser-html').HTMLEvents>).on('parse::end::html', (event) => {
            if (!this._originalDocument) {
                this._originalDocument = event.document;
            }
        });
    }

    /*
     * ------------------------------------------------------------------------------
     * Private methods
     * ------------------------------------------------------------------------------
     */

    /** Returns the HTMLElement that initiated a request */
    private getElementFromRequest(requestId: string, dom: HTMLDocument): HTMLElement | null {
        const sourceRequest = this._requests.get(requestId);

        if (!sourceRequest) {
            return null;
        }

        const { initiator: { type } } = sourceRequest.willBeSent;
        const requestUrl = sourceRequest.originalUrl;

        /*
         * TODO: Check what happens with prefetch, etc.
         * `type` can be "parser", "script", "preload", and "other": https://chromedevtools.github.io/debugger-protocol-viewer/tot/Network/#type-Initiator
         */
        if (['parser', 'other'].includes(type) && requestUrl.startsWith('http')) {
            return getElementByUrl(dom, requestUrl);
        }

        return null;
    }

    /** Event handler for when the browser is about to make a request. */
    private async onRequestWillBeSent(params: Crdp.Network.RequestWillBeSentEvent) {
        const { requestId } = params;
        let requestResponse: RequestResponse;

        if (this._requests.has(requestId)) {
            requestResponse = this._requests.get(requestId) as RequestResponse;
            requestResponse.updateRequestWillBeSent(params);
        } else {
            requestResponse = new RequestResponse(this._client.Network, params, this._options.ignoreHTTPSErrors);
            this._requests.set(requestId, requestResponse);
        }

        const requestUrl: string = params.request.url;

        debug(`About to start fetching ${cutString(requestUrl)} (${params.requestId})`);

        const eventName = this._href === requestUrl ? 'fetch::start::target' : 'fetch::start';

        await this._server.emitAsync(eventName, { resource: requestUrl });
    }

    /** Event handler fired when HTTP request fails for some reason. */
    private async onLoadingFailed(params: Crdp.Network.LoadingFailedEvent) {
        const { requestId } = params;
        const requestResponse = this._requests.get(requestId);

        if (!requestResponse) {
            debug(`(${params.requestId}) Couldn't find associated "RequestResponse", skipping loadingFailed`);

            return;
        }

        const resource = requestResponse.finalUrl;

        /* There is a problem loading the website and we should abort any further processing. */
        if (resource === this._href || resource === this._finalHref) {
            this._errorWithPage = true;

            return;
        }

        // DOM is not ready so we queue up the event for later
        if (!this._dom) {
            this._pendingResponseReceived.push(this.onLoadingFailed.bind(this, params));

            return;
        }

        if (requestResponse.responseReceived) {
            debug(`(${params.requestId}) Error handled during "responseReceived", skipping loadingFailed`);

            return;
        }

        requestResponse.updateLoadingFailed(params);

        debug(`Error found loading ${resource}:\n%O`, params);

        const element: HTMLElement | null = this.getElementFromRequest(params.requestId, this._dom);
        const eventName = 'fetch::error';
        const hops: string[] = requestResponse.hops;

        const event: FetchError = {
            element,
            error: params,
            hops,
            resource
        };

        await this._server.emitAsync(eventName, event);
    }

    private async emitFetchEnd(requestResponse: RequestResponse, dom: HTMLDocument | null) {
        const resourceUrl: string = requestResponse.finalUrl;
        const hops: string[] = requestResponse.hops;
        const originalUrl: string = hops[0] || resourceUrl;

        let element = null;
        /*
         * `dom` should be `null` only if "fetch::end" is for the target
         * (and thus no `dom` is needed )
         */
        const isTarget: boolean = !dom;

        if (dom) {
            try {
                element = await this.getElementFromRequest(requestResponse.requestId, dom);
            } catch (e) {
                debug(`Error finding element for request ${requestResponse.requestId}. element will be null`);
            }
        }

        const response: Response = requestResponse.getResponse(element);

        // Doing a check so TypeScript is happy during `normalizeHeaders` later on
        if (!requestResponse.responseReceived) {

            const message = `Trying to emit "fetch::end" but no responseReceived for ${requestResponse.requestId} found`;

            throw new Error(message);
        }

        const request: Request = {
            headers: normalizeHeaders(requestResponse.responseReceived.response.requestHeaders) as HttpHeaders,
            url: originalUrl
        };

        const data: FetchEnd = {
            element,
            request,
            resource: resourceUrl,
            response
        };

        if (isTarget) {
            this._targetNetworkData = {
                request,
                response
            };

            this._targetReceived();
        }

        /*
         * If the target has a weird value like `application/x-httpd-php`
         * (which translates into `unknown`) or is detected as `xml`.
         * (e.g.: because it starts with
         * `<?xml version="1.0" encoding="utf-8"?>` even though it has
         * `<!DOCTYPE html>` declared after),
         * we change the suffix to `html` so hints work properly.
         */
        let suffix = getType(response.mediaType);
        const defaults = ['unknown', 'xml'];

        if (isTarget && defaults.includes(suffix)) {
            suffix = 'html';
        }

        const eventName = `fetch::end::${suffix}` as 'fetch::end::*';

        /*
         * New versions of chrome are fetching the manifest
         * automatically, so to prevent emit the event `fetch::end::manifest`
         * twice, we need to ignore the event here.
         * The manifest is already captured and processed by
         * `parser-manifest` when the element is detected in the DOM.
         */
        if (suffix === 'manifest') {
            return;
        }


        /** Event is also emitted when status code in response is not 200. */
        await this._server.emitAsync(eventName, data);
    }

    /** Event handler fired when HTTP response is available and DOM loaded. */
    private async onResponseReceived(params: Crdp.Network.ResponseReceivedEvent) {
        const { requestId } = params;
        const requestResponse = this._requests.get(requestId);

        if (!requestResponse) {
            debug(`(${requestId}) ResponseReceived but no requestWillBeSent found`);

            return;
        }

        // Do not update if the process was queued and responseReceived exists already
        if (!requestResponse.responseReceived) {
            requestResponse.updateResponseReceived(params);
        }

        // Need `this._dom` so `emitFetchEnd` can get the element associated to the request
        if (!this._dom) {
            this._pendingResponseReceived.push(this.onResponseReceived.bind(this, params));

            return;
        }

        if (params.response.status === 200) {
            return;
        }

        /*
         * Some status will not emit a `loadingFinished`, like 404 status code.
         * Also, redirects do not emit a `responseReceived`
         */

        await this.emitFetchEnd(requestResponse, this._dom);
    }

    /** Event handler fired when an HTTP request has finished and all the content is available */
    private async onLoadingFinished(params: Crdp.Network.LoadingFinishedEvent) {
        const { requestId } = params;
        const requestResponse = this._requests.get(requestId);

        if (!requestResponse) {
            debug(`(${requestId}) LoadingFinished but no requestWillBeSent found`);

            return;
        }

        await requestResponse.updateLoadingFinished(params);

        const resourceUrl: string = requestResponse.finalUrl;
        const hops: string[] = requestResponse.hops;
        const originalUrl: string = hops[0] || resourceUrl;

        const isTarget: boolean = this._href === originalUrl;

        if (isTarget) {
            await this.emitFetchEnd(requestResponse, null);

            return;
        }

        if (!this._dom) {
            this._pendingResponseReceived.push(this.onLoadingFinished.bind(this, params));

            return;
        }

        await this.emitFetchEnd(requestResponse, this._dom);
    }

    /** Wait until the browser load the first tab */
    private getClient(port: number, tab: number): Promise<object> {
        let retries: number = 0;
        const loadCDP = async (): Promise<any> => {
            try {
                const client = await cdp({ port, tab });

                return client;
            } catch (err) {
                if (retries > 3) {
                    throw err;
                }

                await delay((retries * 250) + 500);
                retries++;

                return loadCDP();
            }
        };

        return loadCDP();
    }

    private async lockFile() {
        try {
            debug(`Trying to acquire lock`);
            await lock(this._lockFile, {
                pollPeriod: 500,
                retries: 20,
                retryWait: 1000,
                stale: 50000,
                wait: 50000
            });
            this._isLocked = true;
            debug(`Lock acquired`);
        } catch (e) {
            /* istanbul ignore next */
            { // eslint-disable-line
                debug(`Error while locking`, e);

                throw e;
            }
        }
    }

    private async unlockFile() {
        if (this._isLocked) {
            debug(`Trying to unlock`);
            await unlock(this._lockFile);
            debug(`Unlock successful`);
        } else {
            debug(`No need to unlock`);
        }
    }

    /** Initiates Chrome if needed and a new tab to start the collection. */
    private async initiateComms() {

        await this.lockFile();

        const launcher: BrowserInfo = await this._launcher.launch('about:blank');
        let client;

        this._pid = launcher.pid;

        /*
         * We want a new tab for this session. If it is a new browser, a new tab
         * will be created automatically. If it was already there, then we need
         * to create it ourselves.
         */
        if (launcher.isNew) {
            // Chrome Launcher could return extensions tabs if installed them but we don't need them.
            const tabs = filter(await cdp.List({ port: launcher.port }), (tab: any) => { // eslint-disable-line new-cap
                return !tab.url.startsWith('chrome-extension');
            });

            // Can assume not-null as `this._launcher.launch` always will return a port.
            client = await this.getClient(launcher.port!, tabs[0]);
            this._tabs = tabs;
        } else {
            const tab = await cdp.New({ port: launcher.port, url: null }); // eslint-disable-line new-cap

            if (!tab) {
                throw new Error('Error trying to open a new tab');
            }

            this._tabs.push(tab);

            client = await cdp({
                port: launcher.port,
                tab: (tabs: any[]): number => {
                    /*
                     * We can return a tab or an index. Also `tab` !== tab[index]
                     * even if the have the same `id`.
                     */
                    for (let index = 0; index < tabs.length; index++) {
                        if (tabs[index].id === tab.id) {
                            return index;
                        }
                    }

                    return -1; // We should never reach this point...
                }
            });
        }

        await this.unlockFile();

        return client;
    }

    /** Handles when there has been an unexpected error talking with the browser. */
    private onError(err: string) {
        debug(`Error: \n${err}`);
    }

    /** Handles when we have been disconnected from the browser. */
    private async onDisconnect() {
        debug(`Disconnected`);
        await this.unlockFile();
    }

    /** Enables the handles for all the relevant Networks events sent by the debugging protocol. */
    private async enableNetworkEvents() {
        debug('Binding to Network events');
        const { Network } = this._client;

        await Promise.all([
            Network.clearBrowserCache!(),
            Network.setCacheDisabled!({ cacheDisabled: true }),
            // The typings we use for CDP aren't 100% compatible with our libarary
            (Network as any)['requestWillBeSent'](this.onRequestWillBeSent.bind(this)), // eslint-disable-line dot-notation
            (Network as any)['responseReceived'](this.onResponseReceived.bind(this)), // eslint-disable-line dot-notation
            (Network as any)['loadingFinished'](this.onLoadingFinished.bind(this)), // eslint-disable-line dot-notation
            (Network as any)['loadingFailed'](this.onLoadingFailed.bind(this)) // eslint-disable-line dot-notation
        ]);
    }

    /** Sets the right configuration and enables all the required CDP features. */
    private async configureAndEnableCDP() {
        const { Network, Page } = this._client;

        // The typings we use for CDP aren't 100% compatible with our libarary
        (this._client as any).on('error', this.onError.bind(this));
        (this._client as any).on('disconnect', this.onDisconnect.bind(this));

        await this.enableNetworkEvents();

        await Promise.all([
            Network.enable!({}),
            Page.enable!()
        ]);
    }

    /**
     * Manually download the site's favicon:
     *
     * * uses the `src` attribute of `<link rel="icon">` if present.
     * * uses `favicon.ico` and the final url after redirects.
     */
    private async getFavicon(dom: HTMLDocument) {
        const element = (await dom.querySelectorAll('link[rel~="icon"]'))[0];
        const href = (element && element.getAttribute('href')) || '/favicon.ico';

        try {
            debug(`resource ${href} to be fetched`);
            const fullFaviconUrl = dom.resolveUrl(href);

            await this._server.emitAsync('fetch::start', { resource: fullFaviconUrl });

            const content = await this.fetchContent(new URL(fullFaviconUrl));

            const data: FetchEnd = {
                element: null,
                request: content.request,
                resource: content.response.url,
                response: content.response
            };

            await this._server.emitAsync('fetch::end::image', data);
        } catch (error) {
            const event: FetchError = {
                element,
                error,
                hops: [],
                resource: href
            };

            await this._server.emitAsync('fetch::error', event);
        }
    }

    /** Processes the pending responses received while the DOM wasn't ready. */
    private async processPendingResponses(): Promise<void> {
        const promises = [];

        while (this._pendingResponseReceived.length) {
            debug(`Pending requests: ${this._pendingResponseReceived.length}`);
            promises.push(this._pendingResponseReceived.shift()!()); // Function will exist due to `length` check above.
        }

        await Promise.all(promises);
    }

    /** Handler fired when page is loaded. */
    private onLoadEventFired(callback: Function): Function {
        return async () => {
            try {
                if (this._errorWithPage) {
                    return callback(new Error(`Problem loading the website ${this._href}`));
                }

                // Sometimes we receive the `onLoadEvent` before the response of the target. See: https://github.com/webhintio/hint/issues/1158
                await this._waitForTarget;

                if (this._options.waitFor) {
                    await delay(this._options.waitFor);

                    // Stop receiving network related events. Useful for pages that do not stop sending telemetry.
                    this._client.Network.disable!();
                }

                const event: Event = { resource: this._finalHref };

                /*
                 * If the target is not an HTML we don't need to
                 * traverse it.
                 */
                if (!isHTMLDocument(this._finalHref, this.headers!)) {
                    await this._server.emitAsync('scan::end', event);

                    return callback();
                }

                const node = await this._client.DOM.getDocument!({ depth: -1 });
                const html = (await this._client.DOM.getOuterHTML!({ nodeId: node.root.nodeId })).outerHTML;
                const dom = createHTMLDocument(html, this._finalHref, this._originalDocument);

                this._dom = dom;

                await this.processPendingResponses();

                await traverse(dom, this._server, node.root.documentURL! || this._finalHref);

                /*
                 * Headless chrome does not download the favicon automatically.
                 * Also we can do it at the end because it uses `fetchContent`
                 * to download it so even though no more `Network` events are
                 * sent, this does not depend on those.
                 * Ref: https://bugs.chromium.org/p/chromium/issues/detail?id=896465
                 */
                if (this._launcher.options &&
                    this._launcher.options.flags &&
                    this._launcher.options.flags.includes('--headless')) {
                    await this.getFavicon(this._dom!);
                }

                await this._server.emitAsync('can-evaluate::script', event);

                // We let time to any pending things (like error networks and so) to happen in the next second
                return setTimeout(async () => {
                    await this._server.emitAsync('scan::end', event);

                    return callback();
                }, 1000);
            } catch (err) {
                return callback(err);
            }
        };
    }

    /*
     * ------------------------------------------------------------------------------
     * Public methods
     * ------------------------------------------------------------------------------
     */

    public collect(target: URL) {
        if (!target.protocol.match(/https?:/)) {
            const err = {
                message: `Protocol "${target.protocol}" invalid for the current collector`,
                type: 'InvalidTarget'
            };

            throw err;
        }

        return promisify(async (callback: Function) => {
            this._href = target.href.replace(target.hash, '');
            this._finalHref = target.href; // This value will be updated if we load the site
            const event: Event = { resource: target.href };
            let client;

            await this._server.emit('scan::start', event);

            try {
                client = await this.initiateComms();
            } catch (e) {
                debug('Error connecting to browser\n%O', e);

                callback(e, null);

                return;
            }

            this._client = client;
            const { Page, Security } = client;

            /*
             * Bypassing the "Your connection is not private"
             * certificate error when using self signed certificate
             * in tests.
             *
             * https://github.com/cyrus-and/chrome-remote-interface/wiki/Bypass-certificate-errors-(%22Your-connection-is-not-private%22)
             *
             * Ignore all the certificate errors.
             */

            if (this._options.ignoreHTTPSErrors) {
                Security.certificateError(({ eventId }: Crdp.Security.CertificateErrorEvent) => {
                    Security.handleCertificateError({
                        action: 'continue',
                        eventId
                    });
                });

                await Security.enable();

                // Enable the override.
                await Security.setOverrideCertificateErrors({ override: true });
            }

            const loadHandler = this.onLoadEventFired(callback);

            // TODO: Investigate why some websites trigger this event twice. Iframe?
            (this._client as any).once('Page.loadEventFired', loadHandler);

            try {
                await this.configureAndEnableCDP();

                await Page.navigate({ url: target.href });
            } catch (e) {
                await this._server.emitAsync('scan::end', event);

                callback(e, null);

                return;
            }
        })();
    }

    public async close() {
        /**
         * On macOS Chrome does not fully exit even if all the tabs are closed.
         * This causes a timeout when running the tests with nyc of about 2
         * minutes (or if the browser is manually closed). This addresses this
         * issue.
         * Because during testing multiple workers are using the same instance of
         * Chrome, one could try to close the browser while another is opening a
         * new tab and thus causing communication issues. The solution is to use
         * the same lock to launch the browser and to close it with a twist: The
         * close method gets all the possible Targets of type page (tabs),
         * close the ones related to the current session and see if there are any
         * other left. If there are not, that means it is safe to completely close
         * the browser by sending a SIGKILL (no other methods works because the
         * debugging protocol client cannot communicate in this state and
         * gracefully close the browser).
         */
        try {
            debug(`Closing connector (${this._pid})`);
            await this.lockFile();

            const { targetInfos } = await this._client.Target.getTargets!();
            const targets = new Set();

            debug(`Pending targets: ${targetInfos.length}`);

            targetInfos.forEach((target) => {
                if (target.type === 'page') {
                    targets.add(target.targetId);
                }
            });

            while (this._tabs.length > 0) {
                debug(`Pending tabs: ${this._tabs.length}`);

                const tab = this._tabs.pop();

                try {
                    if (targets.has(tab.id)) {
                        targets.delete(tab.id);

                        debug(`(${tab.id}) Closing target`);
                        // Need to use `cdp.Close` instead of `Target.closeTarget` because otherwise we could get disconnected directly and never return
                        await cdp.Close({ id: tab.id, port: (this._client as any).port }); // eslint-disable-line new-cap

                        debug(`(${tab.id}) Target closed`);
                    }
                } catch (e) {
                    debug(`Couldn't close target ${tab.id}`);
                }
            }

            try {
                debug(`Closing client`);
                (this._client as any).close();

                if (targets.size === 0 && this._pid) {
                    process.kill(this._pid, 9);
                }
            } catch (e) {
                debug(`Couldn't close the client properly`);
            }
        } catch (e) {
            /* istanbul ignore next */
            { // eslint-disable-line
                debug(`Error while closing`);
                debug(e);
            }
        } finally {
            await this.unlockFile();
        }
    }

    public fetchContent(target: URL | string, customHeaders?: object): Promise<NetworkData> {
        /*
         * TODO: This should create a new tab, navigate to the
         * resource and control what is received somehow via an event.
         */
        const href: string = typeof target === 'string' ? target : target.href;
        const options = {
            headers: customHeaders || {},
            // we sync the ignore SSL error options with `request`. This is neeeded for local https tests
            rejectUnauthorized: !this._options.ignoreHTTPSErrors,
            strictSSL: !this._options.ignoreHTTPSErrors
        };

        const request: Requester = new Requester(options);

        return request.get(href);
    }

    /**
     * The `exceptionDetails` provided by the debugger protocol
     * does not contain the useful information such as name, message,
     * and stack trace of the error when it's wrapped in a promise.
     * Instead, map to a successful object that contains this information.
     * @param {string|Error} err The error to convert istanbul ignore next
     */
    private wrapRuntimeEvalErrorInBrowser(e: Error | null) {
        const err = e || new Error();
        const fallbackMessage: string = typeof err === 'string' ? err : 'unknown error';

        return {
            __failedInBrowser: true,
            message: err.message || fallbackMessage,
            name: err.name || 'Error',
            stack: err.stack || (new Error()).stack
        };
    }

    /**
     * Asynchronoulsy evaluates the given JavaScript code into the browser.
     *
     * This awesomeness comes from lighthouse
     */
    public evaluate(code: string): Promise<any> {

        return new Promise(async (resolve, reject) => {
            // If this gets to 60s and it hasn't been resolved, reject the Promise.
            const asyncTimeout: NodeJS.Timer = setTimeout(
                (() => {
                    reject(new Error(`The script evaluation exceeded the allotted time of ${this._timeout / 1000}s.`));
                }), this._timeout);

            try {
                const expression = `(function wrapInNativePromise() {
          const __nativePromise = window.__nativePromise || Promise;
          return new __nativePromise(function (resolve) {
            return __nativePromise.resolve()
              .then(_ => ${code})
              .catch(function ${this.wrapRuntimeEvalErrorInBrowser.toString()})
              .then(resolve);
          });
        }())`;

                const result = await this._client.Runtime.evaluate!({
                    awaitPromise: true,
                    /*
                     * We need to explicitly wrap the raw expression for several purposes:
                     * 1. Ensure that the expression will be a native Promise and not a polyfill/non-Promise.
                     * 2. Ensure that errors in the expression are captured by the Promise.
                     * 3. Ensure that errors captured in the Promise are converted into plain-old JS Objects
                     *    so that they can be serialized properly b/c JSON.stringify(new Error('foo')) === '{}'
                     */
                    expression,
                    includeCommandLineAPI: true,
                    returnByValue: true
                });

                clearTimeout(asyncTimeout);
                const value = result.result.value;

                if (result.exceptionDetails) {
                    // An error occurred before we could even create a Promise, should be *very* rare
                    return reject(new Error('an unexpected driver error occurred'));
                }

                if (value && value.__failedInBrowser) {
                    return reject(Object.assign(new Error(), value));
                }

                return resolve(value);
            } catch (err) {
                clearTimeout(asyncTimeout);

                return reject(err);
            }
        });
    }

    public querySelectorAll(selector: string): HTMLElement[] {
        if (!this._dom) {
            return [];
        }

        return this._dom.querySelectorAll(selector);
    }

    /*
     * ------------------------------------------------------------------------------
     * Getters
     * ------------------------------------------------------------------------------
     */

    public get dom(): HTMLDocument | undefined {
        return this._dom;
    }

    public get headers() {
        return this._targetNetworkData &&
            this._targetNetworkData.response &&
            normalizeHeaders(this._targetNetworkData.response.headers) ||
            undefined;
    }

    public get html(): string {
        if (!this._dom) {
            return '';
        }

        return this._dom.pageHTML();
    }
}
