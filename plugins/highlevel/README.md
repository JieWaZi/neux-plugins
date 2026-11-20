# HighLevel

Find CRM records, review opportunities, and check calendars in a HighLevel sub-account. This plugin connects to the MCP service hosted by HighLevel.

## Connect

Open Settings → Private Integrations in the HighLevel sub-account, create a token with the scopes you need, and enter the token and the Location ID from the same sub-account.

For CRM review, start with view scopes. The server makes additional actions available when the token has the corresponding permissions.

[Vendor setup guide](https://help.gohighlevel.com/support/solutions/articles/155000005741-how-to-use-the-highlevel-mcp-server)

## Example

> List the open opportunities in this HighLevel location, grouped by pipeline stage.
