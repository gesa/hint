# Hints

A `hint` is a test that your website needs to pass. Webhint comes with
a few [built in ones][hints], but you can create your own or download
them from `npm`. You can read more about [how to create hints in the
contributor guide][how to hint].

## Installing hints

To utilize a hint, first install its package. `hint` supports any
package that starts with `@hint/hint-`, `webhint-hint-`, or
`@namespace/webhint-hint-`. Add the hint to your `.hintrc`'s `hints`
array or object, by name.

For example, to use the [Nu HTML test][html-checker] first install its
package:

```bash
npm i -D @hint/hint-html-checker
```

Then, add `html-checker` to your `.hintrc`.

```json
{
    "hints": [
        "html-checker:error"
    ]
}
```

## Hint configuration

When using `hint`, you are always in control. This means that you can
decide what hints are relevant to your use case and what severity a hint
should have:

* `off`: The hint will not be executed. This is the same as not having
  the hint under the `hints` section of a `.hintrc` file.
* `warning`: The hint will be executed but it will not change the exit
  status code if an issue is found.
* `error`: The hint will be executed and will change the exit status
  code to `1` if an issue is found.

Hints can be configured using the array or object syntax:

```json
{
    "hints": [
        "hint1:warning"
    ]
}
```

```json
{
    "hints": {
        "hint1": "warning"
    }
}
```

The `off` and `warning` hint severities may be applied with shorthand
characters `-` and `?` respectfully when using the array syntax:

A hint that has the `off` severity applied:

```json
{
    "hints": [
        "-hint1"
    ]
}
```

A hint that has the `warning` severity applied:

```json
{
    "hints": [
        "?hint1"
    ]
}
```

Additionally, some hints allow further customization. The configuration
in that case it will be similar to the following:

```json
{
    "hints": [
        ["hint1:warning", {
            "customization1": "value1",
            "customization2": "value2"
        }]
    ]
}
```

or

```json
{
    "hints": [
        {
           "hint1": ["warning", {
             "customization1": "value1",
             "customization2": "value2"
           }]
        }
    ]
}
```

You can check which hints accept this kind of configuration by
visiting the [hints documentation][hints].

<!-- Link labels: -->

[hints]: ../hints/index.md
[how to hint]: ../../contributor-guide/how-to/hint.md
[html-checker]: https://webhint.io/docs/user-guide/hints/hint-html-checker/
