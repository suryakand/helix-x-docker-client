# Registry setup

Every provider uses the Docker Registry v2 / OCI Distribution API for tags, manifests and blobs. They
differ in how credentials are obtained and how repositories are listed.

<a id="generic"></a>

## Generic / custom registry

Use this for CNCF Distribution (`registry:2`), Zot, Quay, Gitea, Forgejo, Harbor without its API, and
others.

- **URL:** `https://registry.example.com` or `host:port`. The `/v2/` path is added automatically.
- **Credentials:** username and password or token. Leave them empty for anonymous access.
- **Repository prefix filter:** optional. Only repositories starting with the prefix are shown.
- **Listing:** uses `/v2/_catalog`. If the registry denies it, open repositories by name and pin them.
- **Local registry over HTTP:** use URL `http://localhost:5000` and turn on **Plain HTTP**.

<a id="docker-hub"></a>

## Docker Hub

- **Username:** your Docker ID.
- **Password:** a Personal Access Token from _Account settings → Personal access tokens_. Read-only is
  enough to browse and pull; _Read & Write_ is needed to push. Delete isn't available through the
  registry API on Hub.
- **Namespace:** the user or organization whose repositories should be listed. Docker Hub has no catalog,
  so the app uses `hub.docker.com/v2/repositories/<namespace>`.
- **Official images:** type `nginx`. It is expanded to `library/nginx`.
- Anonymous access works for public images but is rate limited.

<a id="harbor"></a>

## Harbor

- **URL:** `https://harbor.example.com`.
- **Credentials:** a user account, or a robot account (username `robot$name`, password = its secret).
- **Project (optional):** limits listing to one project. Listing uses the Harbor API
  `/api/v2.0/repositories` and falls back to `_catalog`.

<a id="nexus"></a>

## Sonatype Nexus

- **URL:** the docker connector of a hosted, proxy or group repository, e.g. `https://nexus.example.com:8443`.
  This is the HTTP(S) port configured on the docker repository, not the Nexus UI port.
- **Credentials:** a Nexus user, or a user token.

<a id="artifactory"></a>

## JFrog Artifactory

- **URL:** `https://<server>.jfrog.io`, or your self-hosted host.
- **Credentials:** username plus password, an API key, or an identity token.
- **Repository path method:** images are `<repo-key>/<image>`. Set the prefix filter to `<repo-key>/`
  if needed.

<a id="amazon-ecr"></a>

## Amazon ECR

- **URL:** `https://<account-id>.dkr.ecr.<region>.amazonaws.com`.
- **Region:** taken from the URL if left empty.
- **Credentials:** an IAM access key ID and secret access key. A session token is only needed for
  temporary STS credentials.
- **How it works:** the app calls `ecr:GetAuthorizationToken` (valid for 12 h, cached and refreshed
  automatically) and lists repositories with `ecr:DescribeRepositories`.
- **Minimum IAM policy to browse and pull:**
  ```json
  {
    "Effect": "Allow",
    "Action": [
      "ecr:GetAuthorizationToken",
      "ecr:DescribeRepositories",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchCheckLayerAvailability",
      "ecr:ListImages",
      "ecr:DescribeImages"
    ],
    "Resource": "*"
  }
  ```
  To push, add `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload` and
  `ecr:PutImage`. To delete, add `ecr:BatchDeleteImage`.
- AWS SDK calls do not use the app's proxy setting. Set `HTTPS_PROXY` in the environment if needed.

<a id="google"></a>

## Google Artifact Registry / Container Registry

- **URL:** `https://us-docker.pkg.dev`, `https://europe-west1-docker.pkg.dev`, `https://gcr.io`, …
- **Credentials:** either
  - a **service account key (JSON)**, pasted whole. It is sent as user `_json_key`. The account needs
    _Artifact Registry Reader_ (and _Writer_ to push); or
  - an **access token** from `gcloud auth print-access-token`. It expires after about 1 hour.
- **Project / repository prefix:** e.g. `my-project/my-repo`. This filters the catalog.

<a id="azure-acr"></a>

## Azure Container Registry

- **URL:** `https://<name>.azurecr.io`.
- **Credentials:** one of
  - the admin user (_Access keys_ blade);
  - a repository-scoped token;
  - a service principal: application (client) ID as username and client secret as password, with the
    `AcrPull` / `AcrPush` role.

<a id="ghcr"></a>

## GitHub Container Registry

- **URL:** `https://ghcr.io` (fixed).
- **Username:** your GitHub login.
- **Password:** a Personal Access Token (classic) with `read:packages`. Add `write:packages` to push and
  `delete:packages` to delete.
- **Owner:** the user or organization whose packages should be listed. Listing uses the GitHub
  Packages API.

<a id="gitlab"></a>

## GitLab Container Registry

- **URL:** `https://registry.gitlab.com`, or your instance's registry host.
- **GitLab URL:** the API base, e.g. `https://gitlab.com`. It is derived from the registry host when left empty.
- **Group or project path:** e.g. `my-group` or `my-group/my-project`. Listing uses
  `/api/v4/groups|projects/:id/registry/repositories`.
- **Credentials:** username and a Personal, Project or Group access token with `read_registry`, plus
  `read_api` for listing and `write_registry` to push. Deploy tokens can pull but cannot list.
