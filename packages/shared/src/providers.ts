// Declarative description of each registry provider. The renderer builds the add/edit form from this,
// and the main process uses the same keys when it resolves credentials.
import type { RegistryType } from './types'

export interface ProviderField {
  key: string
  label: string
  kind: 'text' | 'password' | 'textarea'
  required?: boolean
  placeholder?: string
  help?: string
}

export interface ProviderDefinition {
  type: RegistryType
  label: string
  description: string
  defaultUrl?: string
  /** URL is fixed for SaaS registries such as Docker Hub. */
  urlLocked?: boolean
  urlPlaceholder: string
  namespace?: { label: string; required?: boolean; help: string; placeholder?: string }
  region?: boolean
  apiUrl?: { label: string; placeholder: string; help: string }
  credentials: ProviderField[]
  /** At least one of these credential keys must be set (when credentials are required). */
  credentialsOptional: boolean
  docsAnchor: string
}

const userPass = (passLabel = 'Password', passHelp?: string): ProviderField[] => [
  { key: 'username', label: 'Username', kind: 'text', placeholder: 'user' },
  { key: 'password', label: passLabel, kind: 'password', help: passHelp }
]

export const PROVIDERS: ProviderDefinition[] = [
  {
    type: 'generic',
    label: 'Generic / Custom registry',
    description:
      'Any Docker Registry v2 / OCI Distribution compatible registry (CNCF Distribution, Zot, Quay, Gitea …).',
    urlPlaceholder: 'https://registry.example.com:5000',
    credentials: userPass('Password / token'),
    credentialsOptional: true,
    namespace: {
      label: 'Repository prefix filter',
      help: 'Optional. Only show repositories starting with this prefix.',
      placeholder: 'team-a/'
    },
    docsAnchor: 'generic'
  },
  {
    type: 'dockerhub',
    label: 'Docker Hub',
    description: 'hub.docker.com — sign in with your Docker ID and a Personal Access Token.',
    defaultUrl: 'https://registry-1.docker.io',
    urlLocked: true,
    urlPlaceholder: 'https://registry-1.docker.io',
    namespace: {
      label: 'Namespace (user or organization)',
      required: true,
      help: 'Docker Hub does not expose a catalog; repositories are listed for this namespace.',
      placeholder: 'myorg'
    },
    credentials: userPass(
      'Personal access token',
      'Create one at hub.docker.com → Account settings → Personal access tokens.'
    ),
    credentialsOptional: true,
    docsAnchor: 'docker-hub'
  },
  {
    type: 'harbor',
    label: 'Harbor',
    description: 'VMware/CNCF Harbor. Repositories are listed through the Harbor v2 API.',
    urlPlaceholder: 'https://harbor.example.com',
    namespace: {
      label: 'Project (optional)',
      help: 'Limit listing to one Harbor project. Leave empty to list all projects you can see.',
      placeholder: 'library'
    },
    credentials: userPass(
      'Password / CLI secret',
      'Robot accounts are supported: use robot$name as username.'
    ),
    credentialsOptional: true,
    docsAnchor: 'harbor'
  },
  {
    type: 'nexus',
    label: 'Sonatype Nexus',
    description: 'Nexus Repository docker (hosted / proxy / group) connector URL.',
    urlPlaceholder: 'https://nexus.example.com:8443',
    credentials: userPass(),
    credentialsOptional: true,
    docsAnchor: 'nexus'
  },
  {
    type: 'artifactory',
    label: 'JFrog Artifactory',
    description: 'Artifactory docker registry (subdomain or port method).',
    urlPlaceholder: 'https://myco.jfrog.io',
    namespace: {
      label: 'Repository key prefix (optional)',
      help: 'With the repository path method, images are addressed as <repo-key>/<image>.',
      placeholder: 'docker-local/'
    },
    credentials: userPass('Password / identity token'),
    credentialsOptional: true,
    docsAnchor: 'artifactory'
  },
  {
    type: 'ecr',
    label: 'Amazon ECR',
    description: 'AWS Elastic Container Registry. Uses IAM access keys to obtain a 12h registry token.',
    urlPlaceholder: 'https://123456789012.dkr.ecr.us-east-1.amazonaws.com',
    region: true,
    credentials: [
      { key: 'accessKeyId', label: 'Access key ID', kind: 'text', required: true, placeholder: 'AKIA…' },
      { key: 'secretAccessKey', label: 'Secret access key', kind: 'password', required: true },
      {
        key: 'sessionToken',
        label: 'Session token (optional)',
        kind: 'password',
        help: 'Only for temporary STS credentials.'
      }
    ],
    credentialsOptional: false,
    docsAnchor: 'amazon-ecr'
  },
  {
    type: 'gcr',
    label: 'Google Artifact Registry / GCR',
    description:
      'gcr.io or <region>-docker.pkg.dev. Authenticate with a service account key or an access token.',
    defaultUrl: 'https://gcr.io',
    urlPlaceholder: 'https://us-docker.pkg.dev',
    namespace: {
      label: 'Project / repository prefix (optional)',
      help: 'e.g. my-project or my-project/my-repo — filters the catalog.',
      placeholder: 'my-project'
    },
    credentials: [
      {
        key: 'serviceAccountJson',
        label: 'Service account key (JSON)',
        kind: 'textarea',
        help: 'Paste the full JSON key file. Sent as the _json_key user.'
      },
      {
        key: 'accessToken',
        label: 'Or: OAuth access token',
        kind: 'password',
        help: 'Output of `gcloud auth print-access-token` (expires after ~1h).'
      }
    ],
    credentialsOptional: false,
    docsAnchor: 'google'
  },
  {
    type: 'acr',
    label: 'Azure Container Registry',
    description: '<name>.azurecr.io — admin user, repository-scoped token or service principal.',
    urlPlaceholder: 'https://myregistry.azurecr.io',
    credentials: userPass(
      'Password / client secret',
      'For a service principal use the application (client) ID as username.'
    ),
    credentialsOptional: false,
    docsAnchor: 'azure-acr'
  },
  {
    type: 'ghcr',
    label: 'GitHub Container Registry',
    description:
      'ghcr.io — authenticate with a Personal Access Token (read:packages, write:packages, delete:packages).',
    defaultUrl: 'https://ghcr.io',
    urlLocked: true,
    urlPlaceholder: 'https://ghcr.io',
    namespace: {
      label: 'Owner (user or organization)',
      help: 'Packages are listed through the GitHub API for this owner. Leave empty for your own packages.',
      placeholder: 'my-org'
    },
    credentials: userPass('Personal access token'),
    credentialsOptional: false,
    docsAnchor: 'ghcr'
  },
  {
    type: 'gitlab',
    label: 'GitLab Container Registry',
    description: 'registry.gitlab.com or self-managed GitLab. Uses a Personal/Deploy/Project access token.',
    defaultUrl: 'https://registry.gitlab.com',
    urlPlaceholder: 'https://registry.gitlab.com',
    namespace: {
      label: 'Group or project path',
      required: true,
      help: 'Repositories are listed through the GitLab API for this group (or project).',
      placeholder: 'my-group/my-project'
    },
    apiUrl: {
      label: 'GitLab URL',
      placeholder: 'https://gitlab.com',
      help: 'Base URL of the GitLab instance (for the REST API).'
    },
    credentials: userPass('Access token', 'Scopes: read_registry (+ write_registry to push, api to list).'),
    credentialsOptional: false,
    docsAnchor: 'gitlab'
  }
]

export function getProvider(type: RegistryType): ProviderDefinition {
  const p = PROVIDERS.find((x) => x.type === type)
  if (!p) throw new Error(`Unknown registry type: ${type}`)
  return p
}

export const REGISTRY_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0891b2',
  '#475569'
]
