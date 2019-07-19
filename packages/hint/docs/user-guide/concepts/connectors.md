# Connectors

A `connector` is the interface between the `hint`s and the website you
are testing. It is responsible for loading the website and exposing all
the information to `hint` such as resources, network data, etc.

To choose a `connector`, first install its package. The package name
should start with `@hint/connector-`, `webhint-connector-`, or
`@namespace/webhint-connector-`. Then, and add it by name to the
`connector` object within your `.hintrc` file. For example, if you
installed `@hint/connector-local`, add the following:

```json
{
    "connector": {
        "name": "local"
    }
}
```

## Official connectors and platform support

All the built-in `connector`s run in any of the supported platforms:
Linux, macOS, and Windows. The only caveat is that you need to have the
browser or other binary it utilizes installed; webhint will not
install it for you.

## List of official `connector`s

The officially supported `connector`s which can be installed using your
preferred package manager are:

* [`@hint/connector-chrome`][connector-chrome]. Uses the [chrome
  debugging protocol][cdp].
* [`@hint/connector-jsdom`][connector-jsdom]. Uses [jsdom][jsdom].
* [`@hint/connector-local`][connector-local]. Analyzes the local files
  in your project.
* [`@hint/connector-puppeteer`][connector-puppeteer]. Uses
  [puppeteer][puppeteer] to communicate with the browser specified in
  its options object.

## Configuration

`connector`s can be configured. Maybe you want to make a request with
another `userAgent`, change some of the other defaults, etc. For that,
you have to add the property `options` to your `connector` property
with the values you want to modify:

```json
{
    "connector": {
        "name": "connectorName",
        "options": {}
    }
}
```

Check out the documentation for [each official `connector`][connectors]
for more information about the options available.

If you want to implement your own `connector`, visit the [contributor
guide][contributor guide].

<!-- Link labels: -->

[cdp]: https://chromedevtools.github.io/devtools-protocol/
[connector-chrome]: https://webhint.io/docs/user-guide/connectors/connector-chrome/
[connector-jsdom]: https://webhint.io/docs/user-guide/connectors/connector-jsdom/
[connector-local]: https://webhint.io/docs/user-guide/connectors/connector-local/
[connector-puppeteer]: https://webhint.io/docs/user-guide/connectors/connector-puppeteer/
[connectors]: #list-of-official-connectors
[jsdom]: https://github.com/jsdom/jsdom
[puppeteer]: https://pptr.dev/
[contributor guide]: https://webhint.io/docs/contributor-guide/how-to/connector/
