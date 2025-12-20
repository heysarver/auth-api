import sgMail from '@sendgrid/mail';

// Initialize SendGrid
const sendgridApiKey = process.env.SENDGRID_API_KEY;

if (sendgridApiKey) {
  sgMail.setApiKey(sendgridApiKey);
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
 * Send an email using SendGrid
 */
export async function sendEmail(options: EmailOptions): Promise<void> {
  // If SendGrid is not configured, log and return (for development)
  if (!sendgridApiKey) {
    console.log('📧 Email would be sent (SendGrid not configured):');
    console.log('To:', options.to);
    console.log('Subject:', options.subject);
    if (options.text) console.log('Text:', options.text);
    if (options.html) console.log('HTML:', options.html);
    return;
  }

  const appName = process.env.APP_NAME || 'MyApp';
  const productionDomain = process.env.PRODUCTION_DOMAIN || 'example.com';

  const msg: any = {
    to: options.to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL || `noreply@${productionDomain}`,
      name: process.env.SENDGRID_FROM_NAME || appName
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
  token: string
): Promise<void> {
  const appName = process.env.APP_NAME || 'MyApp';
  const productionDomain = process.env.PRODUCTION_DOMAIN || 'example.com';
  const supportEmail = process.env.SUPPORT_EMAIL || `support@${productionDomain}`;

  // Use the verificationUrl directly from better-auth (includes callbackURL redirect)
  const fullVerificationUrl = verificationUrl;

  // Check if we have a SendGrid template ID for verification emails
  const templateId = process.env.SENDGRID_VERIFICATION_TEMPLATE_ID;

  if (templateId) {
    // Use SendGrid dynamic template
    await sendEmail({
      to: email,
      subject: 'Verify your email address',
      templateId,
      dynamicTemplateData: {
        verification_url: fullVerificationUrl,
        app_name: appName,
        support_email: supportEmail
      }
    });
  } else {
    // Use plain HTML/text fallback
    const html = `
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
                <a href="${fullVerificationUrl}" class="button">Verify Email</a>
              </p>
              <p>Or copy and paste this link into your browser:</p>
              <p style="word-break: break-all; background: #fff; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
                ${fullVerificationUrl}
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

    const text = `
Welcome to ${appName}!

Please verify your email address by clicking this link:
${fullVerificationUrl}

This link will expire in 24 hours.

If you didn't create an account with ${appName}, you can safely ignore this email.

Need help? Contact us at ${supportEmail}
    `.trim();

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
  token: string
): Promise<void> {
  const appName = process.env.APP_NAME || 'MyApp';
  const productionDomain = process.env.PRODUCTION_DOMAIN || 'example.com';
  const supportEmail = process.env.SUPPORT_EMAIL || `support@${productionDomain}`;

  // Use the resetUrl directly from better-auth (includes callbackURL redirect)
  const fullResetUrl = resetUrl;

  // Check if we have a SendGrid template ID for password reset emails
  const templateId = process.env.SENDGRID_RESET_TEMPLATE_ID;

  if (templateId) {
    // Use SendGrid dynamic template
    await sendEmail({
      to: email,
      subject: 'Reset your password',
      templateId,
      dynamicTemplateData: {
        reset_url: fullResetUrl,
        app_name: appName,
        support_email: supportEmail
      }
    });
  } else {
    // Use plain HTML/text fallback
    const html = `
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
                <a href="${fullResetUrl}" class="button">Reset Password</a>
              </p>
              <p>Or copy and paste this link into your browser:</p>
              <p style="word-break: break-all; background: #fff; padding: 10px; border: 1px solid #ddd; border-radius: 5px;">
                ${fullResetUrl}
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

    const text = `
Password Reset Request

We received a request to reset your password. Click this link to choose a new password:
${fullResetUrl}

This link will expire in 1 hour for security reasons.

If you didn't request a password reset, you can safely ignore this email.

Need help? Contact us at ${supportEmail}
    `.trim();

    await sendEmail({
      to: email,
      subject: `Reset your password - ${appName}`,
      text,
      html
    });
  }
}
