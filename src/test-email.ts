#!/usr/bin/env tsx
/**
 * Test script for email functionality
 * Run with: npx tsx src/test-email.ts
 */

import dotenv from 'dotenv';
import { sendVerificationEmail, sendPasswordResetEmail } from './lib/email';

// Load environment variables
dotenv.config();

async function testEmails() {
  const testEmail = process.argv[2] || 'test@example.com';

  console.log('🧪 Testing email functionality...');
  console.log(`📧 Sending test emails to: ${testEmail}`);
  console.log('');

  // Check SendGrid configuration
  const hasApiKey = !!process.env.SENDGRID_API_KEY;
  if (hasApiKey) {
    console.log('✅ SendGrid API key is configured');
    console.log(`   From: ${process.env.SENDGRID_FROM_EMAIL || 'noreply@example.com'}`);
    console.log(`   Name: ${process.env.SENDGRID_FROM_NAME || 'MyApp'}`);
  } else {
    console.log('⚠️  SendGrid API key not configured - emails will be logged to console');
  }
  console.log('');

  try {
    // Test verification email
    console.log('1️⃣  Testing verification email...');
    await sendVerificationEmail(
      testEmail,
      'https://example.com/verify-email?token=test-verification-token',
      'test-verification-token'
    );
    console.log('   ✅ Verification email sent successfully');
    console.log('');

    // Small delay between emails
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test password reset email
    console.log('2️⃣  Testing password reset email...');
    await sendPasswordResetEmail(
      testEmail,
      'https://example.com/reset-password?token=test-reset-token',
      'test-reset-token'
    );
    console.log('   ✅ Password reset email sent successfully');
    console.log('');

    console.log('🎉 All email tests completed successfully!');

    if (!hasApiKey) {
      console.log('');
      console.log('💡 To send real emails, add your SendGrid API key to .env:');
      console.log('   SENDGRID_API_KEY=your-api-key-here');
    }
  } catch (error) {
    console.error('❌ Error during email test:', error);
    process.exit(1);
  }
}

// Run the test
testEmails().catch(console.error);
