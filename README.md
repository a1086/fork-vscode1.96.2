# AccoTest

AccoTest is a code editor built from the open-source [VS Code](https://github.com/microsoft/vscode) (`Code - OSS`) repository, customized and distributed by AccoTest under the MIT license.

## The Repository

This repository is where AccoTest maintains its product distribution based on the `Code - OSS` source code. This source code is available to everyone under the standard [MIT license](LICENSE.txt).

## AccoTest

<p align="center">
  <img alt="AccoTest in action" src="docs/images/accotest-screenshot.png">
</p>

AccoTest combines the simplicity of a code editor with what developers need for their core edit-build-debug cycle. It provides comprehensive code editing, navigation, and understanding support along with lightweight debugging, a rich extensibility model, and lightweight integration with existing tools.

AccoTest is updated with new features and bug fixes. You can download it for Windows, macOS, and Linux.

## Contributing

There are many ways in which you can participate in this project, for example:

* Submit bugs and feature requests, and help us verify as they are checked in
* Review source code changes
* Review the documentation and make pull requests for anything from typos to additional and new content

If you are interested in fixing issues and contributing directly to the code base,
please see the document [How to Contribute](CONTRIBUTING.md), which covers the following:

* How to build and run from source
* The development workflow, including debugging and running tests
* Coding guidelines
* Submitting pull requests
* Finding an issue to work on

## Feedback

* Ask a question on [Stack Overflow](https://stackoverflow.com/questions/tagged/accotest)
* Request a new feature
* File an issue in this repository
* Connect with the community on GitHub Discussions

## Related Projects

Many of the core components and extensions to AccoTest live in their own repositories. For a complete list, please visit the Related Projects page.

## Bundled Extensions

VS Code includes a set of built-in extensions located in the [extensions](extensions) folder, including grammars and snippets for many languages. Extensions that provide rich language support (code completion, Go to Definition) for a language have the suffix `language-features`. For example, the `json` extension provides coloring for `JSON` and the `json-language-features` extension provides rich language support for `JSON`.

## Development Container

This repository includes a Visual Studio Code Dev Containers / GitHub Codespaces development container.

* For [Dev Containers](https://aka.ms/vscode-remote/download/containers), use the **Dev Containers: Clone Repository in Container Volume...** command which creates a Docker volume for better disk I/O on macOS and Windows.
  * If you already have VS Code and Docker installed, you can also click [here](https://vscode.dev/redirect?url=vscode://ms-vscode-remote.remote-containers/cloneInVolume?url=https://github.com/microsoft/vscode) to get started. This will cause VS Code to automatically install the Dev Containers extension if needed, clone the source code into a container volume, and spin up a dev container for use.

* For Codespaces, install the [GitHub Codespaces](https://marketplace.visualstudio.com/items?itemName=GitHub.codespaces) extension in VS Code, and use the **Codespaces: Create New Codespace** command.

Docker / the Codespace should have at least **4 Cores and 6 GB of RAM (8 GB recommended)** to run full build. See the [development container README](.devcontainer/README.md) for more information.

## Code of Conduct

This project has adopted the AccoTest Open Source Code of Conduct. For more information see the Code of Conduct FAQ or contact [opensource@accotest.com](mailto:opensource@accotest.com) with any additional questions or comments.

## License

Copyright (c) AccoTest. All rights reserved.

Licensed under the [MIT](LICENSE.txt) license.
