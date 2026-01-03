import sgMail from '@sendgrid/mail';

// Cache email configuration at module load (computed once at startup)
export const EMAIL_CONFIG = {
  appName: process.env.APP_NAME || "MyApp",
  productionDomain: process.env.PRODUCTION_DOMAIN || "example.com",
  supportEmail: process.env.SUPPORT_EMAIL || `support@${process.env.PRODUCTION_DOMAIN || "example.com"}`,
  betterAuthUrl: process.env.BETTER_AUTH_URL || "http://localhost:3002",
  nodeEnv: process.env.NODE_ENV || "development",
  sendgridApiKey: process.env.SENDGRID_API_KEY,
  sendgridFromEmail: process.env.SENDGRID_FROM_EMAIL,
  sendgridFromName: process.env.SENDGRID_FROM_NAME,
  sendgridVerificationTemplateId: process.env.SENDGRID_VERIFICATION_TEMPLATE_ID,
  sendgridResetTemplateId: process.env.SENDGRID_RESET_TEMPLATE_ID,
} as const;

// Initialize SendGrid with cached API key
if (EMAIL_CONFIG.sendgridApiKey) {
  sgMail.setApiKey(EMAIL_CONFIG.sendgridApiKey);
}

interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  templateId?: string;
  dynamicTemplateData?: Record<string, any>;
}

/**
 * Generate verification email HTML using cached config
 */
export function getVerificationEmailHtml(verificationUrl: string): string {
  const { appName, supportEmail } = EMAIL_CONFIG;

  return `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border: 1px solid #ddd; border-radius: 0 0 10px 10px; }
            .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
            .footer { margin-top: 30px; text-align: center; color: #777; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Welcome to ${appName}!</h1>
            </div>
            <div class="content">
              <h2>Verify Your Email Address</h2>
              <p>Thanks for signing up! Please confirm your email address by clicking the button below:</p>
              <p style="text-align: center;">
                <a href="${verificationUrl}" class="button">Verify Email</a>
              </p>
              <p>Or copy and paste this link into your browser:</p>
              <p style="word-break: break-all; background: #fff; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
                ${verificationUrl}
              </p>
              <p>This link will expire in 24 hours.</p>
              <div class="footer">
                <p>If you didn't create an account with ${appName}, you can safely ignore this email.</p>
                <p>Need help? Contact us at ${supportEmail}</p>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
}

/**
 * Generate verification email plain text using cached config
 */
export function getVerificationEmailText(verificationUrl: string): string {
  const { appName, supportEmail } = EMAIL_CONFIG;

  return `
Welcome to ${appName}!

Please verify your email address by clicking this link:
${verificationUrl}

This link will expire in 24 hours.

If you didn't create an account with ${appName}, you can safely ignore this email.

Need help? Contact us at ${supportEmail}
    `.trim();
}

/**
 * Generate password reset email HTML using cached config
 */
export function getPasswordResetEmailHtml(resetUrl: string): string {
  const { supportEmail } = EMAIL_CONFIG;

  return `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
            .content { background: #f9f9f9; padding: 30px; border: 1px solid #ddd; border-radius: 0 0 10px 10px; }
            .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
            .footer { margin-top: 30px; text-align: center; color: #777; font-size: 14px; }
            .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 10px; border-radius: 5px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Password Reset Request</h1>
            </div>
            <div class="content">
              <h2>Reset Your Password</h2>
              <p>We received a request to reset your password. Click the button below to choose a new password:</p>
              <p style="text-align: center;">
                <a href="${resetUrl}" class="button">Reset Password</a>
              </p>
              <p>Or copy and paste this link into your browser:</p>
              <p style="word-break: break-all; background: #fff; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
                ${resetUrl}
              </p>
              <div class="warning">
                <strong>⚠️ Important:</strong> This link will expire in 1 hour for security reasons.
              </div>
              <div class="footer">
                <p>If you didn't request a password reset, you can safely ignore this email.</p>
                <p>Need help? Contact us at ${supportEmail}</p>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
}

/**
 * Generate password reset email plain text using cached config
 */
export function getPasswordResetEmailText(resetUrl: string): string {
  const { supportEmail } = EMAIL_CONFIG;

  return `
Password Reset Request

We received a request to reset your password. Click this link to choose a new password:
${resetUrl}

This link will expire in 1 hour for security reasons.

If you didn't request a password reset, you can safely ignore this email.

Need help? Contact us at ${supportEmail}
    `.trim();
}

/**
 * Send an email using SendGrid
 */
export async function sendEmail(options: EmailOptions): Promise<void> {
  const { sendgridApiKey, appName, productionDomain, sendgridFromEmail, sendgridFromName } = EMAIL_CONFIG;

  // If SendGrid is not configured, log and return (for development)
  if (!sendgridApiKey) {
    console.log('📧 Email would be sent (SendGrid not configured):');
    console.log('To:', options.to);
    console.log('Subject:', options.subject);
    if (options.text) console.log('Text:', options.text);
    if (options.html) console.log('HTML:', options.html);
    return;
  }

  const msg: any = {
    to: options.to,
    from: {
      email: sendgridFromEmail || `noreply@${productionDomain}`,
      name: sendgridFromName || appName
    },
    subject: options.subject,
  };

  // Add content or template
  if (options.templateId) {
    msg.templateId = options.templateId;
    if (options.dynamicTemplateData) {
      msg.dynamicTemplateData = options.dynamicTemplateData;
    }
  } else {
    if (options.text) msg.text = options.text;
    if (options.html) msg.html = options.html;
  }

  try {
    await sgMail.send(msg);
    console.log(`✅ Email sent to ${options.to}`);
  } catch (error: any) {
    console.error('❌ Error sending email:', error);
    if (error.response) {
      console.error('SendGrid response:', error.response.body);
    }
    throw error;
  }
}

/**
 * Send verification email with a custom template
 */
export async function sendVerificationEmail(
  email: string,
  verificationUrl: string,
  _token: string
): Promise<void> {
  const { appName, supportEmail, sendgridVerificationTemplateId } = EMAIL_CONFIG;

  if (sendgridVerificationTemplateId) {
    // Use SendGrid dynamic template
    await sendEmail({
      to: email,
      subject: 'Verify your email address',
      templateId: sendgridVerificationTemplateId,
      dynamicTemplateData: {
        verification_url: verificationUrl,
        app_name: appName,
        support_email: supportEmail
      }
    });
  } else {
    // Use plain HTML/text fallback with template generator functions
    const html = getVerificationEmailHtml(verificationUrl);
    const text = getVerificationEmailText(verificationUrl);

    await sendEmail({
      to: email,
      subject: `Verify your email address - ${appName}`,
      text,
      html
    });
  }
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string,
  _token: string
): Promise<void> {
  const { appName, supportEmail, sendgridResetTemplateId } = EMAIL_CONFIG;

  if (sendgridResetTemplateId) {
    // Use SendGrid dynamic template
    await sendEmail({
      to: email,
      subject: 'Reset your password',
      templateId: sendgridResetTemplateId,
      dynamicTemplateData: {
        reset_url: resetUrl,
        app_name: appName,
        support_email: supportEmail
      }
    });
  } else {
    // Use plain HTML/text fallback with template generator functions
    const html = getPasswordResetEmailHtml(resetUrl);
    const text = getPasswordResetEmailText(resetUrl);

    await sendEmail({
      to: email,
      subject: `Reset your password - ${appName}`,
      text,
      html
    });
  }
}
