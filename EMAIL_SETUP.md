# Email Verification Setup

This document describes how email verification is configured in the auth-api using SendGrid and better-auth.

## 🚀 Quick Start

1. **Get a SendGrid API Key**
   - Sign up at [SendGrid](https://sendgrid.com)
   - Create an API key with email sending permissions
   - Verify your sender domain or email address

2. **Configure Environment Variables**
   Add to your `.env` file:
   ```bash
   # SendGrid Configuration (Required)
   SENDGRID_API_KEY=your-sendgrid-api-key-here
   SENDGRID_FROM_EMAIL=noreply@example.com
   SENDGRID_FROM_NAME=YourApp

   # Optional: Use SendGrid Dynamic Templates
   SENDGRID_VERIFICATION_TEMPLATE_ID=d-xxxxxxxxxxxxx
   SENDGRID_RESET_TEMPLATE_ID=d-xxxxxxxxxxxxx

   # Support email for footer
   SUPPORT_EMAIL=support@example.com

   # Enable email verification requirement
   REQUIRE_EMAIL_VERIFICATION=true
   ```

3. **Test Email Configuration**
   ```bash
   cd auth-api
   npm install
   npx tsx src/test-email.ts your-email@example.com
   ```

## 📧 Email Features

### Email Verification
- Automatically sent when a new user signs up
- Custom HTML template with branding
- Verification link expires in 24 hours
- Auto sign-in after successful verification

### Password Reset
- Sent when user requests password reset
- Secure token-based reset link
- Link expires in 1 hour for security
- Custom branded HTML template

## 🎨 Email Templates

### Default Templates
The system includes beautiful default HTML templates with:
- Responsive design
- Customizable branding
- Clear call-to-action buttons
- Plain text fallbacks

### SendGrid Dynamic Templates (Optional)
You can create custom templates in SendGrid:

1. Go to SendGrid Dashboard > Email API > Dynamic Templates
2. Create templates for verification and password reset
3. Add template IDs to your `.env` file (format: `d-xxxxxxxxxxxxx`)
4. Use these variables in your templates:
   - `{{verification_url}}` - The verification link
   - `{{reset_url}}` - The password reset link
   - `{{app_name}}` - Your application name
   - `{{support_email}}` - Support email address

## 🔧 Configuration Options

### better-auth Settings

```typescript
// In auth.ts
emailVerification: {
  sendOnSignUp: true,              // Auto-send on registration
  autoSignInAfterVerification: true, // Auto login after verification
  sendVerificationEmail: async ({ user, url, token }) => {
    // Custom email sending logic
  },
  afterEmailVerification: async (user) => {
    // Custom logic after verification
  }
}

emailAndPassword: {
  requireEmailVerification: true,   // Block login until verified
  sendResetPassword: async ({ user, url, token }) => {
    // Password reset email logic
  }
}
```

## 🧪 Testing

### Local Development (Without SendGrid)
When `SENDGRID_API_KEY` is not set, emails are logged to the console:
```
📧 Email would be sent (SendGrid not configured):
To: user@example.com
Subject: Verify your email address
```

### With Mailhog (Docker)
The Docker stack includes Mailhog for local email testing:
- SMTP: `localhost:1025`
- Web UI: `http://localhost:8025`

### Production Testing
1. Set up SendGrid with a verified sender
2. Configure all environment variables
3. Run the test script with a real email
4. Check your inbox for the test emails

## 🔒 Security Considerations

1. **Token Security**
   - Verification tokens expire in 24 hours
   - Password reset tokens expire in 1 hour
   - Tokens are single-use only

2. **Rate Limiting**
   - Email sending is rate-limited by better-auth
   - Additional SendGrid rate limits apply

3. **Domain Verification**
   - Always verify your sender domain in SendGrid
   - Use SPF, DKIM, and DMARC for email authentication

## 📝 API Endpoints

The following endpoints are automatically provided by better-auth:

- `POST /api/auth/send-verification-email` - Manually trigger verification email
- `GET /api/auth/verify-email?token=xxx` - Verify email with token
- `POST /api/auth/forget-password` - Request password reset
- `POST /api/auth/reset-password` - Reset password with token

## 🐛 Troubleshooting

### Emails not sending
1. Check SendGrid API key is correct
2. Verify sender email/domain in SendGrid
3. Check SendGrid dashboard for bounces/blocks
4. Review auth-api logs for errors

### Verification links not working
1. Ensure `BETTER_AUTH_URL` is correctly set
2. Check `FRONTEND_URL` for correct redirect
3. Verify database has verification records

### Template issues
1. Test with default templates first
2. Validate SendGrid template IDs (format: `d-xxxxxxxxxxxxx`)
3. Check template variable names match

## 📚 Resources

- [SendGrid Node.js SDK](https://github.com/sendgrid/sendgrid-nodejs)
- [Better Auth Email Docs](https://www.better-auth.com/docs/concepts/email)
- [SendGrid Dynamic Templates](https://docs.sendgrid.com/ui/sending-email/how-to-send-an-email-with-dynamic-templates)
