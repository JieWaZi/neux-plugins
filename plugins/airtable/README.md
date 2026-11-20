# Airtable

Read and update records in the bases assigned to your personal access token. Inspect tables and fields before building a query, or read record comments if the token includes the relevant scope.

## Access

Create a [personal access token](https://airtable.com/create/tokens) and restrict it to the bases you want to use. Choose read-only scopes for reporting and add write scopes only when you need to update records or schemas. Your own Airtable permissions and the token scopes both apply.

The [official hosted MCP server](https://airtable.com/developers/agents/mcp/getting-started) supports personal access tokens. This connection uses that method.

## Examples

- Summarize the active projects in a base and identify records with a missing owner.
- Describe a table's fields before mapping records from another system.
