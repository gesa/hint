# Configurations

A `configuration` is a way to share `.hintrc` values for different use
cases, such as related hints, URLs to ignore, shared organization
standards, etc. When installing a `configuration`, all of its
dependencies (`hint`s, `connnector`s, `formatter`s, `parser`s) should be
installed automatically as well.

Conveniently, any configuration you choose when running
`npm create hintrc` is automatically installed _and_ added to your
`.hintrc` for you.

To manually use a `configuration`, install any package matching
`@hint/configuration-`, `webhint-configuration-`, or
`@namespace/webhint-configuration-`. Once installed, update your
`.hintrc` to use it by adding it to the `extends` array. Given a package
called `webhint-configuration-example1` OR
`@orgname/webhint-configuration-example1`, add the following:

```json
{
    "extends": ["example1"]
}
```

Because the property `extends` is an array of strings, you can extend
from multiple configuration packages. For example, if you wish to add
`@hint/configuration-web-recommended`, `webhint-configuration-example2`,
and `@orgName/webhint-configuration-example3`, your `extends` value will
look like this:

```json
{
    "extends": ["web-recommended", "example2", "example3"]
}
```

Configuration priority applies from left to right. Any values in your
`.hintrc` file will take precedence. For example, the following will
always use the `summary` formatter, regardless of the content of
`example1` and `example2` configurations: (see Notes for more details)

```json
{
    "extends": ["example1", "example2"],
    "formatters": ["summary"]
}
```

Notes:

* If you define the property `formatters` when extending a
  configuration, the formatters in the configuration will be _replaced_
  with the value you have defined.

* If you define the property `parsers` when extending a configuration,
  the parsers in the configuration will be _appended_ to the values you
  have defined.

If you want to implement your own custom configuration, visit the
[contributor guide][contributor guide].

<!-- Link labels: -->

[contributor guide]: https://webhint.io/docs/contributor-guide/how-to/configuration/
