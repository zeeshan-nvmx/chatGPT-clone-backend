const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT,
})

const uploadToS3 = async (file, key) => {
  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  }

  try {
    await s3.send(new PutObjectCommand(params))

    const publicUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.backblazeb2.com/${key}`
    return publicUrl
  } catch (err) {
    console.error('Error uploading file to S3:', err)
    throw err
  }
}

const deleteFromS3 = async (key) => {
  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
  }

  try {
    await s3.send(new DeleteObjectCommand(params))
  } catch (err) {
    console.error('Error deleting file from S3:', err)
    throw err
  }
}

module.exports = {
  uploadToS3,
  deleteFromS3,
}
